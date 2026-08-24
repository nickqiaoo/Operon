import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import OperonAccessibilitySupport
import OperonSystemSoftware

/// `operon-computer-use focus-synthesize --pid <target>`
///
/// Posts the official activation events into a target process and watches
/// whether the target promotes *itself* to the real foreground in response.
///
/// This decides whether `SystemFocusStealPreventer` is load-bearing. If a
/// synthetic activation alone leaves the foreground untouched, the preventer is
/// an edge-case safeguard and the enforcer can be built without it. If the
/// target jumps to the front, the preventer is a prerequisite and has to be
/// understood first.
///
/// No `setFrontProcess` call is made anywhere in this command — that is the
/// point. Nothing here changes the system front process directly, so if the
/// foreground moves, the target moved it.
public enum FocusSynthesizeCLI {
    public static let usage = """
    usage: operon-computer-use focus-synthesize --pid <target> [options]

      --pid <pid>       target process. Required.
      --window <id>     CGWindowID to name in the activation event; defaults to
                        the target's frontmost on-screen window
      --key-focus       also post windowKeyFocusReturned
      --ax-raise        instead of synthetic events, perform the accessibility
                        actions the current click path performs (AXRaise +
                        AXMain + AXFocused on the focused window)
      --legacy          replicate the vendored notifyAppActivatedFromCGWindow
                        sequence instead: activation + a synthetic left-click
                        pair into the window + subtype 0x8000. Use this to find
                        out which part of it moves the foreground.
      --observe-ms <n>  how long to watch afterwards, default 1200
      --help

    Posts only synthesized events via postToPid. It never calls setFrontProcess,
    so any foreground change observed was performed by the target itself.
    """

    public static func run(_ argv: [String]) -> Int32 {
        var targetPID: pid_t?
        var explicitWindow: CGWindowID?
        var alsoKeyFocus = false
        var legacySequence = false
        var axRaise = false
        var observeMilliseconds: Double = 1200
        var index = 0

        while index < argv.count {
            switch argv[index] {
            case "--pid":
                index += 1
                guard index < argv.count, let parsed = pid_t(argv[index]) else {
                    print("focus-synthesize: --pid needs a pid")
                    return 2
                }
                targetPID = parsed
            case "--window":
                index += 1
                guard index < argv.count, let parsed = CGWindowID(argv[index]) else {
                    print("focus-synthesize: --window needs a window id")
                    return 2
                }
                explicitWindow = parsed
            case "--key-focus":
                alsoKeyFocus = true
            case "--legacy":
                legacySequence = true
            case "--ax-raise":
                axRaise = true
            case "--observe-ms":
                index += 1
                guard index < argv.count, let parsed = Double(argv[index]), parsed > 0 else {
                    print("focus-synthesize: --observe-ms needs a positive number")
                    return 2
                }
                observeMilliseconds = parsed
            case "--help", "-h":
                print(usage)
                return 0
            default:
                print("focus-synthesize: unknown flag \(argv[index])\n\n\(usage)")
                return 2
            }
            index += 1
        }

        guard let targetPID else {
            print(usage)
            return 2
        }

        ApplicationRegistrySPI.establishWindowServerConnection()

        guard let baseline = NSWorkspace.shared.frontmostApplication?.processIdentifier else {
            print("focus-synthesize: no frontmost application to use as a baseline")
            return 1
        }
        guard targetPID != baseline else {
            print("focus-synthesize: target is already frontmost; pick a different pid")
            return 1
        }

        let windowID = explicitWindow ?? frontWindow(of: targetPID) ?? 0
        let targetName = NSRunningApplication(processIdentifier: targetPID)?
            .localizedName ?? "pid \(targetPID)"
        print("""
        focus-synthesize
          baseline front : \(baseline)
          target         : \(targetName)(\(targetPID))
          windowID       : \(windowID == 0 ? "none (no modifier flags)" : String(windowID))
          key focus event: \(alsoKeyFocus ? "yes" : "no")
          setFrontProcess: never called
        """)

        var timeline: [(Double, pid_t?, pid_t?)] = []
        let start = Date()
        func sample() {
            timeline.append((
                Date().timeIntervalSince(start) * 1000,
                NSWorkspace.shared.frontmostApplication?.processIdentifier,
                FocusProbe.frontmostWindowOwnerPID()
            ))
        }

        sample()
        let axBefore = accessibilitySnapshot(of: targetPID)

        if axRaise {
            performClickPathAccessibilityActions(on: targetPID)
        } else {
            guard let activation = SynthesizedFocusEvent.appActivated(windowID: windowID) else {
                print("focus-synthesize: could not build the activation event")
                return 1
            }
            activation.send(to: targetPID)
        }
        if !axRaise {
        if legacySequence {
            sendLegacyMousePair(to: targetPID, windowID: windowID)
            // The vendored sequence ends with subtype 0x8000, which the binary
            // shows is "key focus was taken away" — the opposite of what an
            // activation sequence should be saying.
            SynthesizedFocusEvent.windowKeyFocusRemoved()?.send(to: targetPID)
        } else if alsoKeyFocus, let keyFocus = SynthesizedFocusEvent.windowKeyFocusReturned() {
            keyFocus.send(to: targetPID)
        }
        }

        let deadline = Date(timeIntervalSinceNow: observeMilliseconds / 1000)
        while Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.02))
            sample()
        }

        let axAfter = accessibilitySnapshot(of: targetPID)
        let stolen = timeline.filter { $0.1 != baseline || $0.2 != baseline }
        print("\nobserved \(timeline.count) samples over \(Int(observeMilliseconds))ms")
        print("accessibility effect: \(axBefore) -> \(axAfter)")
        if axBefore == axAfter {
            print("""
              NOTE: the accessibility state did not change. A "foreground never
              moved" result is only meaningful if the event landed at all, so
              treat this run as inconclusive unless the target was already
              publishing a focused window.
            """)
        }
        if stolen.isEmpty {
            print("""
            RESULT: the foreground never moved.
            The target did not promote itself, so a focus-steal preventer is not
            required just to make synthetic activation safe.
            """)
            return 0
        }

        print("RESULT: the foreground moved \(stolen.count) sample(s) after the synthetic activation:")
        for (elapsed, workspace, topWindow) in stolen.prefix(6) {
            print(String(
                format: "  +%.0fms workspaceFront=%@ topWindow=%@",
                elapsed,
                workspace.map(String.init) ?? "-",
                topWindow.map(String.init) ?? "-"
            ))
        }
        print("""

        The target promoted itself in response to a synthetic activation, so
        SystemFocusStealPreventer is a prerequisite, not a safeguard.
        """)
        return 1
    }

    /// What `activateClickTarget` does on every click today: raise the window
    /// and mark it main/focused. `AXRaise` reorders windows for real, so this
    /// is the default-path candidate for the flicker.
    private static func performClickPathAccessibilityActions(on pid: pid_t) {
        let app = AXUIElementCreateApplication(pid)
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            app, kAXFocusedWindowAttribute as CFString, &focused
        ) == .success, let element = focused, CFGetTypeID(element) == AXUIElementGetTypeID()
        else {
            print("  (target publishes no focused window; nothing to raise)")
            return
        }
        let window = element as! AXUIElement
        let raise = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        let main = AXUIElementSetAttributeValue(
            window, kAXMainAttribute as CFString, kCFBooleanTrue
        )
        let focus = AXUIElementSetAttributeValue(
            window, kAXFocusedAttribute as CFString, kCFBooleanTrue
        )
        print("  AXRaise=\(raise.rawValue) AXMain=\(main.rawValue) AXFocused=\(focus.rawValue)")
    }

    /// The part of the vendored sequence that the official builder has no
    /// equivalent for: a synthesized left-click posted into the target window.
    private static func sendLegacyMousePair(to pid: pid_t, windowID: CGWindowID) {
        guard windowID != 0, let bounds = windowBounds(of: windowID) else {
            return
        }
        let point = CGPoint(x: bounds.midX, y: bounds.minY + min(16, bounds.height / 2))
        let windowPoint = CGPoint(x: point.x - bounds.minX, y: point.y - bounds.minY)

        for (type, number) in [(NSEvent.EventType.leftMouseDown, 1), (.leftMouseUp, 2)] {
            guard let nsEvent = NSEvent.mouseEvent(
                with: type,
                location: windowPoint,
                modifierFlags: [],
                timestamp: 0,
                windowNumber: Int(windowID),
                context: nil,
                eventNumber: number,
                clickCount: 1,
                pressure: 1
            ), let event = nsEvent.cgEvent else {
                continue
            }
            event.flags = []
            event.location = point
            event.setIntegerValueField(.mouseEventButtonNumber, value: 0)
            event.setIntegerValueField(.mouseEventSubtype, value: 3)
            event.setIntegerValueField(
                .mouseEventWindowUnderMousePointer, value: Int64(windowID)
            )
            event.setIntegerValueField(
                .mouseEventWindowUnderMousePointerThatCanHandleThisEvent,
                value: Int64(windowID)
            )
            event.timestamp = CGEventTimestamp(
                ProcessInfo.processInfo.systemUptime * 1_000_000_000
            )
            event.postToPid(pid)
        }
    }

    private static func windowBounds(of windowID: CGWindowID) -> CGRect? {
        guard let list = CGWindowListCopyWindowInfo(
            [.optionIncludingWindow], windowID
        ) as? [[String: Any]],
        let info = list.first,
        let dictionary = info[kCGWindowBounds as String] as? NSDictionary
        else {
            return nil
        }
        return CGRect(dictionaryRepresentation: dictionary)
    }

    /// Cheap evidence that the synthetic event actually reached the target:
    /// Electron and Chromium apps only publish a focused window and hydrate
    /// their tree once they believe they are active.
    private static func accessibilitySnapshot(of pid: pid_t) -> String {
        let app = AXUIElementCreateApplication(pid)
        var focused: CFTypeRef?
        let hasFocusedWindow = AXUIElementCopyAttributeValue(
            app, kAXFocusedWindowAttribute as CFString, &focused
        ) == .success && focused != nil
        var windows: CFTypeRef?
        let windowCount: Int
        if AXUIElementCopyAttributeValue(
            app, kAXWindowsAttribute as CFString, &windows
        ) == .success, let list = windows as? [AXUIElement] {
            windowCount = list.count
        } else {
            windowCount = 0
        }
        return "focusedWindow=\(hasFocusedWindow) windows=\(windowCount)"
    }

    private static func frontWindow(of pid: pid_t) -> CGWindowID? {
        guard let infoList = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else {
            return nil
        }
        for info in infoList {
            guard let owner = info[kCGWindowOwnerPID as String] as? pid_t, owner == pid,
                  let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
                  let number = info[kCGWindowNumber as String] as? NSNumber
            else {
                continue
            }
            return CGWindowID(number.uint32Value)
        }
        return nil
    }
}
