import Carbon.HIToolbox
import CoreGraphics
import Foundation

/// One synthesized key press: what Codex models as `SAIVirtualKeyPress`
/// (ivars `_keyCode`, `_modifiers`, `_string`).
///
/// The three fields travel together on purpose — the official builder
/// sets **all three** on both the keyDown and the keyUp:
///
/// ```
/// createKeyboardEvent(source:, virtualKey: keyCode, keyDown:)
/// setFlags(event, modifiers)
/// keyboardSetUnicodeString(event, string)
/// ```
///
/// Our two keyboard paths each used to supply half of that: `typeText` sent
/// `virtualKey: 0` + a unicode string (no real key, no flags), `pressKey` sent a
/// real key + flags but no string. Apps that only look at one of the two — a
/// native AppKit app reads the key code, Chromium is happy with the string —
/// therefore saw a broken event from one path or the other.
struct VirtualKeyPress: Equatable, Sendable {
    /// Virtual key code, or `unmappedKeyCode` when the character has no key on
    /// the current layout and only the unicode string can carry it.
    var keyCode: CGKeyCode
    var modifiers: CGEventFlags
    /// The text this press produces. Always set, including for pure key presses
    /// like Return, where it is the control character the key emits.
    var string: String

    /// Codex sends `virtualKey: 0` for string-only presses; keep the same value
    /// so the wire behaviour matches for characters we cannot map.
    static let unmappedKeyCode: CGKeyCode = 0

    var isMapped: Bool { keyCode != Self.unmappedKeyCode || string.isEmpty }
}

/// Reverse lookup from the *current* keyboard layout: character → key code plus
/// the modifiers needed to produce it.
///
/// Codex's `+[SAIVirtualKeyPress keyPressesForString:]` does the
/// same job. Building it from `UCKeyTranslate` rather than a hard-coded US table
/// keeps typing correct on non-US layouts.
enum KeyboardLayoutMap {
    /// Modifier combinations worth probing, with the `CGEventFlags` they imply.
    /// `UCKeyTranslate` wants a Carbon modifier key state (bits 8-15 of an event
    /// record's modifiers field), hence the shifted constants.
    private static let probes: [(carbonState: UInt32, flags: CGEventFlags)] = [
        (0, []),
        (UInt32(shiftKey >> 8), .maskShift),
        (UInt32(optionKey >> 8), .maskAlternate),
        (UInt32((shiftKey | optionKey) >> 8), [.maskShift, .maskAlternate]),
    ]

    /// Guarded by `lock`; `nonisolated(unsafe)` documents that the lock is the
    /// synchronisation, not the compiler.
    private static let lock = NSLock()
    nonisolated(unsafe) private static var cached: [String: VirtualKeyPress]?

    /// character → press, for every character the current layout can type.
    static func table() -> [String: VirtualKeyPress] {
        lock.lock()
        defer { lock.unlock() }
        if let cached {
            return cached
        }
        let built = build()
        cached = built
        return built
    }

    /// Drops the cache; call when the input source changes.
    static func invalidate() {
        lock.lock()
        cached = nil
        lock.unlock()
    }

    /// Whatever text a key emits, **including control characters** — Return's
    /// `\r`, Delete's `\u{8}`, Tab's `\t`.
    ///
    /// `table()` deliberately omits these so that typing "\r" does not resolve to
    /// the Return key, but a key press still has to carry them: measured on QQ
    /// (Electron), a key event whose unicode string is empty is **ignored**,
    /// which is why `pressKey("delete")` did nothing there while `type("a")`
    /// worked through the same primitive.
    static func characters(keyCode: CGKeyCode, modifiers: CGEventFlags) -> String {
        guard
            let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
            let rawLayout = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
        else {
            return ""
        }
        let layoutData = Unmanaged<CFData>.fromOpaque(rawLayout).takeUnretainedValue() as Data

        var carbonState: UInt32 = 0
        if modifiers.contains(.maskShift) { carbonState |= UInt32(shiftKey >> 8) }
        if modifiers.contains(.maskAlternate) { carbonState |= UInt32(optionKey >> 8) }
        if modifiers.contains(.maskControl) { carbonState |= UInt32(controlKey >> 8) }
        // Command is deliberately not translated: macOS reports the *unshifted*
        // characters for command chords, and UCKeyTranslate agrees when the bit
        // is left out.

        var result = ""
        layoutData.withUnsafeBytes { buffer in
            guard let layout = buffer.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else {
                return
            }
            var deadKeyState: UInt32 = 0
            var length = 0
            var chars = [UniChar](repeating: 0, count: 8)
            let status = UCKeyTranslate(
                layout,
                UInt16(keyCode),
                UInt16(kUCKeyActionDown),
                carbonState,
                UInt32(LMGetKbdType()),
                OptionBits(kUCKeyTranslateNoDeadKeysBit),
                &deadKeyState,
                chars.count,
                &length,
                &chars
            )
            if status == noErr, length > 0 {
                result = String(utf16CodeUnits: chars, count: length)
            }
        }
        return result
    }

    private static func build() -> [String: VirtualKeyPress] {
        guard
            let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
            let rawLayout = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
        else {
            return [:]
        }
        let layoutData = Unmanaged<CFData>.fromOpaque(rawLayout).takeUnretainedValue() as Data

        var table: [String: VirtualKeyPress] = [:]
        layoutData.withUnsafeBytes { buffer in
            guard let layout = buffer.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else {
                return
            }
            for keyCode in 0..<CGKeyCode(128) {
                for probe in probes {
                    var deadKeyState: UInt32 = 0
                    var length = 0
                    var chars = [UniChar](repeating: 0, count: 8)
                    let status = UCKeyTranslate(
                        layout,
                        UInt16(keyCode),
                        UInt16(kUCKeyActionDown),
                        probe.carbonState,
                        UInt32(LMGetKbdType()),
                        OptionBits(kUCKeyTranslateNoDeadKeysBit),
                        &deadKeyState,
                        chars.count,
                        &length,
                        &chars
                    )
                    guard status == noErr, length > 0 else {
                        continue
                    }
                    let text = String(utf16CodeUnits: chars, count: length)
                    // Control characters are reached through named keys, not by
                    // typing them; leaving them out keeps `Return` from being
                    // mapped as the character "\r".
                    guard !text.isEmpty, text.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else {
                        continue
                    }
                    // First writer wins: probes run least-modified first, so a
                    // character reachable without modifiers never gets the
                    // shift/option variant.
                    if table[text] == nil {
                        table[text] = VirtualKeyPress(
                            keyCode: keyCode,
                            modifiers: probe.flags,
                            string: text
                        )
                    }
                }
            }
        }
        return table
    }
}

extension VirtualKeyPress {
    /// Codex `+[SAIVirtualKeyPress keyPressesForString:]` — split text into the
    /// key presses that produce it.
    ///
    /// Characters with no key on the current layout (CJK, emoji, anything from
    /// an IME) keep `unmappedKeyCode` and travel as a unicode string only, which
    /// is what our old `typeText` did for *everything*. Chromium accepts those;
    /// native AppKit does not, which is precisely why typing used to fail there.
    static func presses(for text: String) -> [VirtualKeyPress] {
        let table = KeyboardLayoutMap.table()
        return text.map { character in
            let string = String(character)
            if let mapped = table[string] {
                return mapped
            }
            return VirtualKeyPress(
                keyCode: unmappedKeyCode,
                modifiers: [],
                string: string
            )
        }
    }
}
