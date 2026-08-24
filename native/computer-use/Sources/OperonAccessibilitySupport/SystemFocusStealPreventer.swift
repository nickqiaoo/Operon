import AppKit
import CoreGraphics
import Foundation
import OperonSystemSoftware

/// Codex `AccessibilitySupport.SystemFocusStealPreventer`.
///
/// Per controlled pid (`DisallowedThiefProcess`):
/// - system process-notification tap: swallow CPS focus notifications when the
///   *target* is the thief (trying to become real front after synthetic activation)
/// - optional per-pid mouse taps (official `mouseEventTaps`)
/// - ViewBridge keyboard tap for Settings / SwiftUI
/// - menu-dismissal suppression hooks
public enum SystemFocusStealPreventer {
    /// Official ViewBridge keyboard tap mask (`0x1c00` from binary).
    public static let viewBridgeKeyboardEventMask: UInt64 =
        (1 << CGEventType.keyDown.rawValue)
        | (1 << CGEventType.keyUp.rawValue)
        | (1 << CGEventType.flagsChanged.rawValue)

    private static let lock = NSLock()
    nonisolated(unsafe) private static var entries: [pid_t: Entry] = [:]
    nonisolated(unsafe) private static var processNotificationTap: EventTap?
    nonisolated(unsafe) private static var viewBridgeKeyboardTap: EventTap?

    private struct Entry {
        var targetLostFocusHandler: (() -> Void)?
        var targetGainedFocusHandler: (() -> Void)?
        var mouseEventTaps: [EventTap] = []
        var isMenuDismissalSuppressionEnabled = false
        var menuPID: pid_t?
    }

    public static func startPreventingFocusStealing(
        for pid: pid_t,
        targetLostFocusHandler: (() -> Void)? = nil,
        targetGainedFocusHandler: (() -> Void)? = nil
    ) {
        lock.lock()
        var entry = entries[pid] ?? Entry()
        entry.targetLostFocusHandler = targetLostFocusHandler
        entry.targetGainedFocusHandler = targetGainedFocusHandler
        if entry.mouseEventTaps.isEmpty {
            entry.mouseEventTaps = installMouseEventTaps(for: pid)
        }
        entries[pid] = entry
        ensureSystemTapsLocked()
        lock.unlock()
    }

    public static func stopPreventingFocusStealing(for pid: pid_t) {
        lock.lock()
        if let entry = entries.removeValue(forKey: pid) {
            for tap in entry.mouseEventTaps {
                tap.stopMonitoring()
            }
        }
        if entries.isEmpty {
            tearDownSystemTapsLocked()
        }
        lock.unlock()
    }

    /// Codex `startSuppressingMenuDismissalEvents(for:menuPID:)`.
    public static func startSuppressingMenuDismissalEvents(
        for pid: pid_t,
        menuPID: pid_t?
    ) {
        lock.lock()
        var entry = entries[pid] ?? Entry()
        entry.isMenuDismissalSuppressionEnabled = true
        entry.menuPID = menuPID
        entries[pid] = entry
        ensureSystemTapsLocked()
        lock.unlock()
    }

    public static func stopSuppressingMenuDismissalEvents(for pid: pid_t) {
        lock.lock()
        if var entry = entries[pid] {
            entry.isMenuDismissalSuppressionEnabled = false
            entry.menuPID = nil
            entries[pid] = entry
        }
        lock.unlock()
    }

    // MARK: - system taps

    private static func ensureSystemTapsLocked() {
        if processNotificationTap == nil {
            let tap = EventTap(
                eventTypes: CPSNotification.eventTypeMask,
                location: .annotatedSession,
                placement: .tailAppendEventTap,
                // Passive on purpose. Measured: with this tap active
                // (`.defaultTap`), scroll events we post with `CGEventPostToPid`
                // stop reaching a background target entirely — the window-local
                // stamp no longer survives, and a scroll event has no NSEvent
                // behind it to fall back on, so the target drops it. Flipping
                // this one option to `.listenOnly` is what makes background
                // scroll work; nothing else in the focus stack matters (A/B'd:
                // enforcer off, per-pid mouse taps off, ViewBridge tap off,
                // marker off — all still broken; this alone fixes it).
                //
                // The cost is that we can no longer swallow a focus-theft
                // notification. §1.9 measured that suppression is not a
                // precondition for background operation, so observing is
                // enough until a target is found that actually needs it.
                options: .listenOnly
            )
            tap.shouldAutoreenable = true
            if tap.startMonitoring({ _, event in handleProcessNotification(event) }) {
                processNotificationTap = tap
            }
        }

        if viewBridgeKeyboardTap == nil, let vbPID = viewBridgeAuxiliaryPID() {
            // Official mask: `mov w25, #0x1c00`
            // = keyDown | keyUp | flagsChanged (no scroll).
            let tap = EventTap(
                eventTypes: viewBridgeKeyboardEventMask,
                location: .pid(vbPID),
                placement: .tailAppendEventTap,
                options: .defaultTap
            )
            tap.shouldAutoreenable = true
            if tap.startMonitoring({ _, event in
                handleViewBridgeEvent(event)
            }) {
                viewBridgeKeyboardTap = tap
            }
        }
    }

    private static func tearDownSystemTapsLocked() {
        processNotificationTap?.stopMonitoring()
        processNotificationTap = nil
        viewBridgeKeyboardTap?.stopMonitoring()
        viewBridgeKeyboardTap = nil
    }

    /// Official `DisallowedThiefProcess.mouseEventTaps` — per-pid mouse family.
    private static func installMouseEventTaps(for pid: pid_t) -> [EventTap] {
        let mouseMask: UInt64 =
            (1 << CGEventType.leftMouseDown.rawValue)
            | (1 << CGEventType.leftMouseUp.rawValue)
            | (1 << CGEventType.rightMouseDown.rawValue)
            | (1 << CGEventType.rightMouseUp.rawValue)
            | (1 << CGEventType.otherMouseDown.rawValue)
            | (1 << CGEventType.otherMouseUp.rawValue)
            | (1 << CGEventType.leftMouseDragged.rawValue)
            | (1 << CGEventType.rightMouseDragged.rawValue)
            | (1 << CGEventType.scrollWheel.rawValue)
        let tap = EventTap(
            eventTypes: mouseMask,
            location: .pid(pid),
            placement: .tailAppendEventTap,
            options: .listenOnly // observe; do not block real user input to target
        )
        tap.shouldAutoreenable = true
        _ = tap.startMonitoring { _, event in
            // Real user input to the controlled app must pass. Synthetic
            // Computer Use events are tagged and also pass.
            event
        }
        return [tap]
    }

    private static func handleProcessNotification(_ event: CGEvent) -> CGEvent? {
        guard let observation = CPSNotification.observe(event) else {
            return event
        }
        lock.lock()
        let snapshot = entries
        lock.unlock()

        // Thief = process taking focus (subjectPID).
        guard let thief = observation.subjectPID, let entry = snapshot[thief] else {
            return event
        }

        // Target became the focus thief — notify and swallow.
        // Official: if focusThiefAlsoStoleTypingFocus, still call gained handler
        // (typing focus rode along with key focus).
        _ = CPSNotification.focusThiefAlsoStoleTypingFocus(event)
        entry.targetGainedFocusHandler?()
        return nil
    }

    private static func handleViewBridgeEvent(_ event: CGEvent) -> CGEvent? {
        lock.lock()
        let suppressing = entries.values.contains(where: \.isMenuDismissalSuppressionEnabled)
        lock.unlock()
        guard suppressing else {
            return event
        }
        // While menu-dismissal suppression is on, drop Escape via ViewBridge.
        if event.type == .keyDown {
            let keycode = event.getIntegerValueField(.keyboardEventKeycode)
            if keycode == 53 { // Escape
                return nil
            }
        }
        return event
    }

    private static func viewBridgeAuxiliaryPID() -> pid_t? {
        NSWorkspace.shared.runningApplications.first(where: {
            let bid = $0.bundleIdentifier ?? ""
            let name = $0.localizedName ?? ""
            return bid.localizedCaseInsensitiveContains("ViewBridgeAuxiliary")
                || name.localizedCaseInsensitiveContains("ViewBridge")
        })?.processIdentifier
    }
}
