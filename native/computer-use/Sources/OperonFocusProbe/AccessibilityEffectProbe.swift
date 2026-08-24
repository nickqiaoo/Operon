import ApplicationServices
import Foundation

/// Cheap evidence that a synthetic event actually reached its target.
///
/// Electron and Chromium apps only publish a focused window once they believe
/// they are active, so this doubles as the positive control for any "the
/// foreground never moved" result — without it, a run where nothing happened
/// at all is indistinguishable from a run that worked.
enum AccessibilityEffectProbe {
    struct Snapshot: Equatable, CustomStringConvertible {
        var hasFocusedWindow: Bool
        var windowCount: Int

        var description: String {
            "focusedWindow=\(hasFocusedWindow) windows=\(windowCount)"
        }
    }

    static func snapshot(of pid: pid_t) -> Snapshot {
        let app = AXUIElementCreateApplication(pid)

        var focused: CFTypeRef?
        let hasFocusedWindow = AXUIElementCopyAttributeValue(
            app,
            kAXFocusedWindowAttribute as CFString,
            &focused
        ) == .success && focused != nil

        var windows: CFTypeRef?
        var windowCount = 0
        if AXUIElementCopyAttributeValue(
            app,
            kAXWindowsAttribute as CFString,
            &windows
        ) == .success, let list = windows as? [AXUIElement] {
            windowCount = list.count
        }

        return Snapshot(hasFocusedWindow: hasFocusedWindow, windowCount: windowCount)
    }
}
