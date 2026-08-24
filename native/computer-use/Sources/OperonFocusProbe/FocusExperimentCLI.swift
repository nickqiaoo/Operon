import AppKit
import CoreGraphics
import Foundation
import OperonAccessibilitySupport
import OperonSystemSoftware

/// `operon-computer-use focus-experiment --pid <target>`
///
/// Performs one real background activation and records exactly what it did.
///
/// This is the experiment the whole design rests on: call
/// `_SLPSSetFrontProcessWithOptions(target, 0, noWindows | causedByUser)`,
/// watch the four foreground signals and the CPS notification stream, then put
/// the original front process back. It answers two questions that cannot be
/// answered by reading a binary: whether `noWindows` alone already keeps the
/// target off screen, and what the resulting notifications actually look like
/// — which is what the suppressor has to recognise.
///
/// The original front process is restored unconditionally, including on early
/// return, so a failed run cannot leave the user's foreground on the target.
public enum FocusExperimentCLI {
    public static let usage = """
    usage: operon-computer-use focus-experiment --pid <target> [--hold-ms <n>]

      --pid <pid>      process to background-activate. Required.
      --hold-ms <n>    how long to hold the activation before restoring, default 800
      --suppress       install an ACTIVE tap that drops the CPS notifications
                       about the target, i.e. the actual hiding mechanism
      --tap-location   session|annotated|hid, default annotated
      --help

    Calls a private write SPI against a real process and restores the previous
    front process afterwards. Prefer a target with no visible windows the first
    time you run it.
    """

    public static func run(_ argv: [String]) -> Int32 {
        var targetPID: pid_t?
        var holdMilliseconds: Double = 800
        var suppress = false
        var tapLocation = EventTap.Location.annotatedSession
        var index = 0

        while index < argv.count {
            switch argv[index] {
            case "--pid":
                index += 1
                guard index < argv.count, let parsed = pid_t(argv[index]) else {
                    print("focus-experiment: --pid needs a pid")
                    return 2
                }
                targetPID = parsed
            case "--hold-ms":
                index += 1
                guard index < argv.count, let parsed = Double(argv[index]), parsed > 0 else {
                    print("focus-experiment: --hold-ms needs a positive number")
                    return 2
                }
                holdMilliseconds = parsed
            case "--suppress":
                suppress = true
            case "--tap-location":
                index += 1
                switch index < argv.count ? argv[index] : "" {
                case "session":
                    tapLocation = .session
                case "annotated":
                    tapLocation = .annotatedSession
                case "hid":
                    tapLocation = .hid
                default:
                    print("focus-experiment: --tap-location must be session|annotated|hid")
                    return 2
                }
            case "--help", "-h":
                print(usage)
                return 0
            default:
                print("focus-experiment: unknown flag \(argv[index])\n\n\(usage)")
                return 2
            }
            index += 1
        }

        guard let targetPID else {
            print(usage)
            return 2
        }

        ApplicationRegistrySPI.establishWindowServerConnection()

        guard ApplicationRegistrySPI.canSetFrontProcess else {
            print("focus-experiment: _SLPSSetFrontProcessWithOptions unavailable")
            return 1
        }
        guard let baseline = NSWorkspace.shared.frontmostApplication,
              let baselinePSN = ApplicationRegistrySPI.serialNumber(
                  for: baseline.processIdentifier
              )
        else {
            print("focus-experiment: could not resolve the current front process")
            return 1
        }
        guard let targetPSN = ApplicationRegistrySPI.serialNumber(for: targetPID) else {
            print("focus-experiment: pid \(targetPID) has no process serial number")
            return 1
        }
        guard targetPID != baseline.processIdentifier else {
            print("focus-experiment: target is already frontmost; pick a different pid")
            return 1
        }

        let targetName = NSRunningApplication(processIdentifier: targetPID)?
            .localizedName ?? "pid \(targetPID)"
        print("""
        focus-experiment
          baseline front : \(baseline.localizedName ?? "?")(\(baseline.processIdentifier))
          target         : \(targetName)(\(targetPID))
          options        : noWindows | causedByUser
          suppression    : \(suppress ? "on (active tap)" : "off (listen-only)")
        """)

        var events: [String] = []
        var swallowed = 0
        let table = FocusEventsCLI.ProcessTable()
        let tap = EventTap(
            eventTypes: CPSNotification.eventTypeMask,
            location: tapLocation,
            // An active tap is the only kind that can drop an event. This is
            // the difference between watching the activation and hiding it.
            options: suppress ? .defaultTap : .listenOnly
        )
        let tapped = tap.startMonitoring { _, event in
            guard let observation = CPSNotification.observe(event) else {
                return event
            }
            events.append(describe(observation, event: event, table: table))
            guard suppress, observation.subjectPID == targetPID else {
                return event
            }
            swallowed += 1
            return nil
        }
        if !tapped {
            print("  (event tap unavailable; continuing without notification capture)")
        }
        defer { tap.stopMonitoring() }

        // Restoration is registered before the activation so that any later
        // failure still hands the foreground back.
        defer {
            ApplicationRegistrySPI.setFrontProcess(
                baselinePSN,
                windowID: 0,
                options: .withoutRaisingWindows
            )
        }

        var timeline: [String] = []
        func sample(_ label: String) {
            let workspace = NSWorkspace.shared.frontmostApplication?.processIdentifier
            let cpsFront = ApplicationRegistrySPI.frontProcess()
            let keyFocus = ApplicationRegistrySPI.keyFocusProcess()?.process
            timeline.append(
                "  \(label): workspaceFront=\(workspace.map(String.init) ?? "-")"
                    + " cpsFront=\(cpsFront.map { String($0.low) } ?? "-")"
                    + " keyFocus=\(keyFocus.map { String($0.low) } ?? "-")"
                    + " topWindow=\(FocusProbe.frontmostWindowOwnerPID().map(String.init) ?? "-")"
            )
        }

        sample("before   ")
        let status = ApplicationRegistrySPI.setFrontProcess(
            targetPSN,
            windowID: 0,
            options: .withoutRaisingWindows
        )
        print("  setFrontProcess -> CGError \(status.map(String.init) ?? "unavailable")")

        let deadline = Date(timeIntervalSinceNow: holdMilliseconds / 1000)
        var tick = 0
        while Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
            tick += 1
            if tick % 4 == 0 {
                sample("holding  ")
            }
        }
        sample("after    ")

        print("\ntimeline (psn low for cps/keyFocus, pid for workspace/topWindow):")
        print(timeline.joined(separator: "\n"))

        if suppress {
            print("\nsuppression: swallowed \(swallowed) of \(events.count) notification(s)")
        }
        print("\ncaptured \(events.count) CPS notification(s):")
        for line in events.prefix(24) {
            print("  \(line)")
        }
        print("""

        reference: target psn low = \(targetPSN.low), baseline psn low = \(baselinePSN.low)
        """)
        return 0
    }

    private static func describe(
        _ observation: CPSNotification.Observation,
        event: CGEvent,
        table: FocusEventsCLI.ProcessTable
    ) -> String {
        var parts: [String] = []
        for raw in 0..<Int(256) {
            guard let field = CGEventField(rawValue: UInt32(raw)) else {
                continue
            }
            let value = event.getIntegerValueField(field)
            guard value != 0 else {
                continue
            }
            // Sequence counters and timestamps change on every event and would
            // bury the fields that carry meaning.
            if [39, 40, 58, 85, 169].contains(raw) {
                continue
            }
            let annotation = table.annotate(value).map { "‹\($0)›" } ?? ""
            parts.append("f\(raw)=0x\(String(value, radix: 16))\(annotation)")
        }
        return parts.joined(separator: " ")
    }
}
