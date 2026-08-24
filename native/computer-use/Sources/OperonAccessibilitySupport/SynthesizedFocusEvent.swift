import AppKit
import CoreGraphics
import Foundation
import OperonSystemSoftware

/// The focus notifications the official service posts straight into a target
/// process, reconstructed by observing the reference implementation.
///
/// These are *outbound*: each one is built as an `NSEvent`, converted to a
/// `CGEvent` and delivered with `postToPid`, so only the target sees it. The
/// system's front process is never changed. That is the whole trick — the
/// target believes it was activated while the user's foreground is untouched.
///
/// Every constant below was read out of the binary rather than guessed, which
/// matters because two of them are counter-intuitive (see `windowKeyFocusRemoved`).
public struct SynthesizedFocusEvent {
    public let event: CGEvent

    /// `NSEvent.EventType.appKitDefined`.
    static let appKitDefinedType: NSEvent.EventType = .appKitDefined

    /// The event type carrying CPS focus notifications. The official builder
    /// loads this from a lazily-initialised global; 21 (`kCGSEventNotify`) is
    /// inferred from that being the exact type its notification tap registers.
    public static let processNotificationTypeRawValue: UInt = 21

    /// `kEventAppActivated` / `kEventAppDeactivated`, the two AppKit-defined
    /// subtypes. Read directly out of `notifyAppActivated`/`notifyAppDeactivated`.
    static let appActivatedSubtype: Int16 = 1
    static let appDeactivatedSubtype: Int16 = 2

    /// Modifier flags the official builder sets when a window is supplied:
    /// `0xC0000` = control | option. There is no way to guess this one, and our
    /// vendored implementation independently arrived at the same pair — which
    /// is the strongest single sign that layer was reversed correctly.
    static let windowActivationModifiers: NSEvent.ModifierFlags = [.control, .option]

    private init(event: CGEvent) {
        self.event = event
    }

    /// Rebuilds `SynthesizedEvent.notifyAppActivated(windowID:windowBounds:activationPoint:)`.
    ///
    /// Official signature also takes optional bounds / activation point. When a
    /// window id is known we stamp control|option (confirmed). Callers that
    /// have bounds should prefer `appActivated(windowID:windowBounds:)` so a
    /// non-clicking mouseMoved can arm Electron hit-testing without z-order
    /// raise (the old left-click pair was what flashed windows).
    public static func appActivated(windowID: CGWindowID) -> SynthesizedFocusEvent? {
        make(
            type: appKitDefinedType,
            modifierFlags: windowID == 0 ? [] : windowActivationModifiers,
            windowNumber: Int(windowID),
            subtype: appActivatedSubtype
        )
    }

    /// Activation + optional arming clicks when bounds are known.
    ///
    /// The reference `notifyAppActivated(windowID:windowBounds:activationPoint:)`
    /// behaves as follows:
    /// 1. Always: `NSEvent.otherEvent(.appKitDefined, subtype: 1, …)` —
    ///    modifiers `0xC0000` (control|option) when `windowID != 0`.
    /// 2. When `windowID != 0` **and** `windowBounds != nil` **and**
    ///    `activationPoint == nil`: append **leftMouseDown + leftMouseUp** at
    ///    the point derived from bounds (midpoint; RE uses the CGPoint pair
    ///    passed alongside the rect). Field packing matches `mouseEvent`:
    ///    flags=0, location=global, field 3 (buttonNumber)=0, field 7
    ///    (subtype)=3, fields 0x5b/0x5c = windowID, then
    ///    `WindowServerSPI.setWindowLocation` (window-local).
    ///
    /// Older Operon code used a single `mouseMoved` here — that does **not**
    /// match the binary. Down/up is what Codex posts (no front process change;
    /// process-local only via `postToPid`).
    public static func appActivatedSequence(
        windowID: CGWindowID,
        windowBounds: CGRect?
    ) -> [SynthesizedFocusEvent] {
        var events: [SynthesizedFocusEvent] = []
        if let base = appActivated(windowID: windowID) {
            events.append(base)
        }
        guard
            windowID != 0,
            let bounds = windowBounds,
            bounds.width > 8,
            bounds.height > 8
        else {
            return events
        }
        // Official uses the activation CGPoint from bounds geometry; midpoint
        // matches the call sites that pass window center when no explicit point.
        let point = CGPoint(x: bounds.midX, y: bounds.midY)
        // NSEvent window-local: AppKit bottom-left within window for classic
        // non-flipped path; RE always runs setWindowLocation for these two
        // events (no flipped early-out in notifyAppActivated). Use top-left
        // local for NSEvent construction consistency with sendClick flipped
        // Electron windows — CGEvent.location still carries global `point`.
        let local = CGPoint(x: point.x - bounds.minX, y: point.y - bounds.minY)
        for (type, eventNumber, pressure) in [
            (NSEvent.EventType.leftMouseDown, 1, Float(1)),
            (.leftMouseUp, 2, Float(1)),
        ] {
            guard
                let ns = NSEvent.mouseEvent(
                    with: type,
                    location: local,
                    modifierFlags: [],
                    timestamp: 0,
                    windowNumber: Int(windowID),
                    context: nil,
                    eventNumber: eventNumber,
                    clickCount: 1,
                    pressure: pressure
                ),
                let cg = ns.cgEvent
            else {
                continue
            }
            applyCodexMouseFields(
                to: cg,
                globalPoint: point,
                windowLocalPoint: local,
                windowID: windowID,
                buttonNumber: 0
            )
            events.append(SynthesizedFocusEvent(event: cg))
        }
        return events
    }

    /// Field packing shared with official `SynthesizedEvent.mouseEvent` /
    /// notifyAppActivated arming clicks.
    ///
    /// - field 3 = `mouseEventButtonNumber`
    /// - field 7 = `mouseEventSubtype` ← always **3**
    /// - field 0x5b / 0x5c = window under mouse (when windowID known)
    /// - Parameter windowLocalPoint: point relative to the window's origin. The
    ///   official builder derives it from the event's own location
    ///   (`translate(-bounds.minX, -bounds.minY)`) before handing it to
    ///   `WindowServerSPI.setWindowLocation`; this used to be given the *global*
    ///   point instead, which is a whole window-origin off (583,143 for a typical
    ///   QQ window) and therefore meaningless to the receiver.
    static func applyCodexMouseFields(
        to event: CGEvent,
        globalPoint: CGPoint,
        windowLocalPoint: CGPoint,
        windowID: CGWindowID,
        buttonNumber: Int64
    ) {
        event.flags = []
        event.location = globalPoint
        event.setIntegerValueField(.mouseEventButtonNumber, value: buttonNumber)
        event.setIntegerValueField(.mouseEventSubtype, value: 3)
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowID))
        event.setIntegerValueField(
            .mouseEventWindowUnderMousePointerThatCanHandleThisEvent,
            value: Int64(windowID)
        )
        // Best-effort private SPI; missing symbol is fine (fields above still set).
        WindowServerEventSPI.setWindowLocation(event, location: windowLocalPoint)
    }

    public static func appDeactivated() -> SynthesizedFocusEvent? {
        make(
            type: appKitDefinedType,
            modifierFlags: [],
            windowNumber: 0,
            subtype: appDeactivatedSubtype
        )
    }

    /// `notifyWindowKeyFocusReturned()` — confirmed to use
    /// `kCPSNotifyKeyFocusReturned` (0xF102).
    public static func windowKeyFocusReturned() -> SynthesizedFocusEvent? {
        processNotification(subtype: CPSNotification.Subtype.keyFocusReturned)
    }

    /// `notifyWindowKeyFocusRemoved()` — confirmed to use
    /// **`kCPSNotifyKeyFocusTaken` (0x8000)**, not `kCPSNotifyLostKeyFocus`.
    ///
    /// The pairing was established by matching the global each builder loads
    /// against the addressor of each subtype getter, not by
    /// reading the names. "Removed" is expressed as "someone else took it",
    /// which is the opposite of the obvious guess.
    public static func windowKeyFocusRemoved() -> SynthesizedFocusEvent? {
        processNotification(subtype: CPSNotification.Subtype.keyFocusTaken)
    }

    private static func processNotification(
        subtype: CPSNotification.Subtype
    ) -> SynthesizedFocusEvent? {
        guard let type = NSEvent.EventType(rawValue: processNotificationTypeRawValue) else {
            return nil
        }
        // The table stores these as the unsigned values the binary compiles in
        // (0x8000, 0xF102), while NSEvent takes a signed Int16. Reinterpreting
        // the bits is the correct conversion; `Int16(exactly:)` would reject
        // both of them.
        let narrowed = Int16(bitPattern: UInt16(truncatingIfNeeded: subtype.rawValue))
        return make(
            type: type,
            modifierFlags: [],
            windowNumber: 0,
            subtype: narrowed
        )
    }

    private static func make(
        type: NSEvent.EventType,
        modifierFlags: NSEvent.ModifierFlags,
        windowNumber: Int,
        subtype: Int16
    ) -> SynthesizedFocusEvent? {
        guard let nsEvent = NSEvent.otherEvent(
            with: type,
            location: .zero,
            modifierFlags: modifierFlags,
            timestamp: 0,
            windowNumber: windowNumber,
            context: nil,
            subtype: subtype,
            data1: 0,
            data2: 0
        ),
        let cgEvent = nsEvent.cgEvent
        else {
            return nil
        }
        return SynthesizedFocusEvent(event: cgEvent)
    }

    /// `SynthesizedEvent.send(to:)` — delivers to one process only.
    public func send(to pid: pid_t) {
        event.timestamp = CGEventTimestamp(
            ProcessInfo.processInfo.systemUptime * 1_000_000_000
        )
        event.postToPid(pid)
    }
}
