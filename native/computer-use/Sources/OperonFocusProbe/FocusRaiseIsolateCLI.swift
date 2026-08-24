import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import OperonAccessibilitySupport
import OperonSystemSoftware

/// `operon-computer-use focus-raise-isolate --app <bundle-or-name>`
///
/// Runs each hydrate step in isolation while sampling whether the target
/// becomes the top window owner (z-order flash without front-process steal).
public enum FocusRaiseIsolateCLI {
    public static let usage = """
    usage: operon-computer-use focus-raise-isolate --app <name-or-bundle-id>
    """

    public static func run(_ argv: [String]) -> Int32 {
        var appQuery: String?
        var index = 0
        while index < argv.count {
            switch argv[index] {
            case "--app":
                index += 1
                guard index < argv.count else {
                    print(usage)
                    return 2
                }
                appQuery = argv[index]
            case "--help", "-h":
                print(usage)
                return 0
            default:
                print("unknown flag \(argv[index])\n\(usage)")
                return 2
            }
            index += 1
        }
        guard let appQuery else {
            print(usage)
            return 2
        }

        ApplicationRegistrySPI.establishWindowServerConnection()
        guard let target = NSWorkspace.shared.runningApplications.first(where: {
            $0.bundleIdentifier == appQuery
                || $0.localizedName == appQuery
                || ($0.bundleIdentifier?.localizedCaseInsensitiveContains(appQuery) ?? false)
                || ($0.localizedName?.localizedCaseInsensitiveContains(appQuery) ?? false)
        }) else {
            print("focus-raise-isolate: app not running: \(appQuery)")
            return 2
        }
        let pid = target.processIdentifier
        let windowID = frontWindowID(of: pid) ?? 0
        let appElement = AXUIElementCreateApplication(pid)
        print("""
        focus-raise-isolate
          target : \(target.localizedName ?? "?")(\(pid))
          window : \(windowID)
          front  : \(NSWorkspace.shared.frontmostApplication?.localizedName ?? "?")(\(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1))
        """)

        let steps: [(String, () -> Void)] = [
            ("noop", {}),
            ("enforcer windowID=0", {
                _ = SyntheticAppFocusEnforcer(pid: pid).enforceActiveState(windowID: 0)
            }),
            ("enforcer windowID", {
                _ = SyntheticAppFocusEnforcer(pid: pid).enforceActiveState(windowID: windowID)
            }),
            ("appKitActivated no window", {
                postAppKitActivated(pid: pid, windowID: 0, modifiers: [])
            }),
            ("appKitActivated +window+mods", {
                postAppKitActivated(pid: pid, windowID: windowID, modifiers: [.control, .option])
            }),
            ("keyFocusReturned 0xF102", {
                postKeyFocusReturned(pid: pid)
            }),
            ("AXFocusedWindow", {
                if let window = anyWindow(appElement) {
                    _ = AXUIElementSetAttributeValue(
                        appElement,
                        kAXFocusedWindowAttribute as CFString,
                        window
                    )
                }
            }),
            ("AXFocused", {
                if let window = anyWindow(appElement) {
                    _ = AXUIElementSetAttributeValue(
                        window,
                        kAXFocusedAttribute as CFString,
                        kCFBooleanTrue
                    )
                }
            }),
            ("AXMain", {
                if let window = anyWindow(appElement) {
                    _ = AXUIElementSetAttributeValue(
                        window,
                        kAXMainAttribute as CFString,
                        kCFBooleanTrue
                    )
                }
            }),
            ("unhide", {
                _ = target.unhide()
            }),
            ("AXManualAccessibility", {
                _ = AXUIElementSetAttributeValue(
                    appElement,
                    "AXManualAccessibility" as CFString,
                    kCFBooleanTrue
                )
            }),
            ("AXEnhancedUserInterface", {
                _ = AXUIElementSetAttributeValue(
                    appElement,
                    "AXEnhancedUserInterface" as CFString,
                    kCFBooleanTrue
                )
            }),
            ("combo: enforcer+appKit+keyFocus", {
                _ = SyntheticAppFocusEnforcer(pid: pid).enforceActiveState(windowID: windowID)
                postAppKitActivated(pid: pid, windowID: windowID, modifiers: [.control, .option])
                postKeyFocusReturned(pid: pid)
            }),
            ("combo+AXFocusedWindow", {
                _ = SyntheticAppFocusEnforcer(pid: pid).enforceActiveState(windowID: windowID)
                postAppKitActivated(pid: pid, windowID: windowID, modifiers: [.control, .option])
                postKeyFocusReturned(pid: pid)
                if let window = anyWindow(appElement) {
                    _ = AXUIElementSetAttributeValue(
                        appElement,
                        kAXFocusedWindowAttribute as CFString,
                        window
                    )
                }
            }),
        ]

        var anyRaise = false
        for (name, step) in steps {
            Thread.sleep(forTimeInterval: 0.4)
            // Nudge unrelated app above target if we can — otherwise "already top"
            // hides raises. We don't activate; we just wait if user left something else front.
            let result = observe(targetPID: pid, duration: 0.85, body: step)
            let mark = result.raised ? "RAISE" : (result.alreadyTop ? "skip" : "ok  ")
            if result.raised { anyRaise = true }
            let first = result.firstHitMs.map { String(format: "%.0f", $0) } ?? "-"
            let top = result.topBefore.map(String.init) ?? "-"
            print("  [\(mark)] \(name.padding(toLength: 32, withPad: " ", startingAt: 0)) hits=\(result.hits) first=+\(first)ms topBefore=\(top)")
        }

        print(anyRaise
            ? "\nRESULT: at least one step reordered the target window"
            : "\nRESULT: no step made target topWindow (or target was already top)")
        return anyRaise ? 1 : 0
    }

    private struct ObserveResult {
        var raised: Bool
        var alreadyTop: Bool
        var hits: Int
        var firstHitMs: Double?
        var topBefore: pid_t?
    }

    private static func observe(
        targetPID: pid_t,
        duration: TimeInterval,
        body: () -> Void
    ) -> ObserveResult {
        let topBefore = FocusProbe.frontmostWindowOwnerPID()
        let buffer = SampleBuffer()
        let stop = AtomicFlag()
        let t0 = ProcessInfo.processInfo.systemUptime
        let thread = Thread {
            while !stop.isSet {
                let top = FocusProbe.frontmostWindowOwnerPID()
                buffer.append(((ProcessInfo.processInfo.systemUptime - t0) * 1000, top))
                Thread.sleep(forTimeInterval: 0.005)
            }
        }
        thread.stackSize = 256 * 1024
        thread.start()
        Thread.sleep(forTimeInterval: 0.05)
        body()
        Thread.sleep(forTimeInterval: duration)
        stop.set()
        Thread.sleep(forTimeInterval: 0.02)

        let alreadyTop = topBefore == targetPID
        var hits = 0
        var first: Double?
        if !alreadyTop {
            for (ms, top) in buffer.all where top == targetPID {
                hits += 1
                if first == nil { first = ms }
            }
        }
        return ObserveResult(
            raised: hits > 0,
            alreadyTop: alreadyTop,
            hits: hits,
            firstHitMs: first,
            topBefore: topBefore
        )
    }

    private static func postAppKitActivated(
        pid: pid_t,
        windowID: CGWindowID,
        modifiers: NSEvent.ModifierFlags
    ) {
        guard let event = NSEvent.otherEvent(
            with: .appKitDefined,
            location: .zero,
            modifierFlags: modifiers,
            timestamp: 0,
            windowNumber: Int(windowID),
            context: nil,
            subtype: 1,
            data1: 0,
            data2: 0
        ),
        let cg = event.cgEvent
        else { return }
        cg.timestamp = CGEventTimestamp(ProcessInfo.processInfo.systemUptime * 1_000_000_000)
        cg.postToPid(pid)
    }

    private static func postKeyFocusReturned(pid: pid_t) {
        guard let type = NSEvent.EventType(rawValue: 21),
              let event = NSEvent.otherEvent(
                with: type,
                location: .zero,
                modifierFlags: [],
                timestamp: 0,
                windowNumber: 0,
                context: nil,
                subtype: Int16(bitPattern: 0xF102),
                data1: 0,
                data2: 0
              ),
              let cg = event.cgEvent
        else { return }
        cg.timestamp = CGEventTimestamp(ProcessInfo.processInfo.systemUptime * 1_000_000_000)
        cg.postToPid(pid)
    }

    private static func frontWindowID(of pid: pid_t) -> CGWindowID? {
        guard let list = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else { return nil }
        for info in list {
            guard let owner = info[kCGWindowOwnerPID as String] as? pid_t, owner == pid,
                  let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
                  let number = info[kCGWindowNumber as String] as? NSNumber
            else { continue }
            return CGWindowID(number.uint32Value)
        }
        return nil
    }

    private static func anyWindow(_ appElement: AXUIElement) -> AXUIElement? {
        var value: CFTypeRef?
        if AXUIElementCopyAttributeValue(
            appElement, kAXFocusedWindowAttribute as CFString, &value
        ) == .success,
           let value,
           CFGetTypeID(value) == AXUIElementGetTypeID()
        {
            return (value as! AXUIElement)
        }
        var windows: CFTypeRef?
        if AXUIElementCopyAttributeValue(
            appElement, kAXWindowsAttribute as CFString, &windows
        ) == .success,
           let arr = windows as? [AXUIElement],
           let first = arr.first
        {
            return first
        }
        return nil
    }

    private final class SampleBuffer: @unchecked Sendable {
        private let lock = NSLock()
        private var storage: [(Double, pid_t?)] = []
        func append(_ sample: (Double, pid_t?)) {
            lock.withLock { storage.append(sample) }
        }
        var all: [(Double, pid_t?)] { lock.withLock { storage } }
    }

    private final class AtomicFlag: @unchecked Sendable {
        private let lock = NSLock()
        private var value = false
        var isSet: Bool { lock.withLock { value } }
        func set() { lock.withLock { value = true } }
    }
}
