import AppKit
import CoreGraphics
import Foundation
import OperonAccessibilitySupport
import OperonSystemSoftware

/// `operon-computer-use focus-enforce --pid <target>`
///
/// Drives a real `SyntheticAppFocusEnforcer` against a live application and
/// reports the two properties Phase 3 has to deliver together: repeated
/// enforcement stops posting anything, and the visible foreground never moves.
///
/// Either property alone is easy and useless — an enforcer that posts nothing
/// also never moves the foreground.
public enum FocusEnforceCLI {
    public static let usage = """
    usage: operon-computer-use focus-enforce --pid <target> [--rounds <n>] [--keep]

      --pid <pid>    target process. Required.
      --rounds <n>   how many times to call enforceActiveState, default 3
      --keep         skip deactivateFocusEnforcer at the end
      --help

    Exit code is 1 if the foreground moved, or if enforcement never settled to
    a no-op.
    """

    public static func run(_ argv: [String]) -> Int32 {
        var targetPID: pid_t?
        var rounds = 3
        var keep = false
        var index = 0

        while index < argv.count {
            switch argv[index] {
            case "--pid":
                index += 1
                guard index < argv.count, let parsed = pid_t(argv[index]) else {
                    print("focus-enforce: --pid needs a pid")
                    return 2
                }
                targetPID = parsed
            case "--rounds":
                index += 1
                guard index < argv.count, let parsed = Int(argv[index]), parsed > 0 else {
                    print("focus-enforce: --rounds needs a positive number")
                    return 2
                }
                rounds = parsed
            case "--keep":
                keep = true
            case "--help", "-h":
                print(usage)
                return 0
            default:
                print("focus-enforce: unknown flag \(argv[index])\n\n\(usage)")
                return 2
            }
            index += 1
        }

        guard let targetPID else {
            print(usage)
            return 2
        }
        // The baseline is whatever the user already had in front. Activating
        // something to create a known baseline would itself move the foreground,
        // which is the exact thing under test — an earlier version of this
        // command did that and produced failures caused purely by its own setup.
        guard let baseline = waitForStableForeground() else {
            print("""
            focus-enforce: the foreground never settled, so any result would be
            measuring whatever else is moving it. Retry once the desktop is idle.
            """)
            return 1
        }
        guard targetPID != baseline else {
            print("focus-enforce: target is already frontmost; pick a different pid")
            return 1
        }

        ApplicationRegistrySPI.establishWindowServerConnection()

        let windowID = frontWindow(of: targetPID) ?? 0
        let name = NSRunningApplication(processIdentifier: targetPID)?
            .localizedName ?? "pid \(targetPID)"
        print("""
        focus-enforce
          baseline front : \(baseline)
          target         : \(name)(\(targetPID))
          windowID       : \(windowID == 0 ? "none" : String(windowID))
          rounds         : \(rounds)
        """)

        let before = AccessibilityEffectProbe.snapshot(of: targetPID)
        let enforcer = SyntheticAppFocusEnforcer(pid: targetPID)

        var foregroundMoved = false
        var decisions: [FocusEnforcementDecision] = []
        for round in 1...rounds {
            let decision = enforcer.enforceActiveState(windowID: windowID)
            decisions.append(decision)
            print("  round \(round): \(describe(decision))")

            let deadline = Date(timeIntervalSinceNow: 0.35)
            while Date() < deadline {
                RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.02))
                if NSWorkspace.shared.frontmostApplication?.processIdentifier != baseline
                    || FocusProbe.frontmostWindowOwnerPID() != baseline {
                    foregroundMoved = true
                }
            }
        }

        let after = AccessibilityEffectProbe.snapshot(of: targetPID)
        if !keep {
            enforcer.deactivateFocusEnforcer()
        }

        print("\naccessibility effect: \(before) -> \(after)")
        let settled = decisions.dropFirst().allSatisfy(\.isNoOp)
        print("first round acted   : \(!(decisions.first?.isNoOp ?? true))")
        print("later rounds no-op  : \(settled)")
        print("foreground moved    : \(foregroundMoved)")

        guard !foregroundMoved else {
            print("\nFAIL: the visible foreground moved during enforcement")
            return 1
        }
        guard settled else {
            print("\nFAIL: enforcement never settled; it would keep posting events forever")
            return 1
        }
        print("\nPASS: enforcement settled to a no-op and the foreground never moved")
        return 0
    }

    /// Returns the frontmost pid once it has held still, or nil if it never does.
    ///
    /// Without this the tail of an unrelated app switch lands inside the
    /// measurement window and reads as a foreground steal.
    private static func waitForStableForeground(
        requiredConsecutiveSamples: Int = 15,
        timeout: TimeInterval = 3
    ) -> pid_t? {
        let deadline = Date(timeIntervalSinceNow: timeout)
        var lastReading: (pid_t?, pid_t?)?
        var stableCount = 0

        while Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.02))
            let reading = (
                NSWorkspace.shared.frontmostApplication?.processIdentifier,
                FocusProbe.frontmostWindowOwnerPID()
            )
            if let lastReading, lastReading == reading {
                stableCount += 1
                if stableCount >= requiredConsecutiveSamples, let pid = reading.0 {
                    return pid
                }
            } else {
                stableCount = 0
            }
            lastReading = reading
        }
        return nil
    }

    private static func describe(_ decision: FocusEnforcementDecision) -> String {
        if decision.isNoOp {
            return "no-op (posted nothing)"
        }
        var parts: [String] = []
        if decision.postActivation { parts.append("appActivated") }
        if decision.postKeyFocusReturned { parts.append("keyFocusReturned") }
        return "posted " + parts.joined(separator: " + ")
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
