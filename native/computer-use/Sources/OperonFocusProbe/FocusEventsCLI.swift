import AppKit
import CoreGraphics
import Foundation
import OperonAccessibilitySupport
import OperonSystemSoftware

/// `operon-computer-use focus-events`
///
/// Dumps live CPS process-notification events (`1 << 21`) with their subtype
/// and payload. Two jobs: prove the `EventTap` wrapper actually receives that
/// event stream, and collect the real samples needed to work out how
/// `focusTheftID` is encoded — which is still an open item.
///
/// The tap is created read-only (`.listenOnly`) so this command can never
/// swallow a real user event.
public enum FocusEventsCLI {
    public static let usage = """
    usage: operon-computer-use focus-events [--duration <s>] [--pid <pid>] [--all-subtypes]

      --duration <s>   stop after s seconds; omit to run until Ctrl-C
      --pid <pid>      tap that process only (CGEvent.tapCreateForPid) instead
                       of the whole session
      --all-subtypes   print every CPS notification, not only ones whose
                       subtype matches the table recovered from the official
                       binary (currently: none do — see CPSNotification)
      --raw            also dump non-zero CGEvent integer fields, which is how
                       the still-unknown subtype/theft-id encoding gets pinned
                       down (NSEvent mis-decodes this event type)
      --help

    The tap is listen-only and never modifies or drops events.
    """

    public static func run(_ argv: [String]) -> Int32 {
        var duration: Double?
        var targetPID: pid_t?
        var allSubtypes = false
        var dumpRawFields = false
        var index = 0

        while index < argv.count {
            let flag = argv[index]
            switch flag {
            case "--duration":
                index += 1
                guard index < argv.count, let parsed = Double(argv[index]), parsed > 0 else {
                    print("focus-events: --duration needs a positive number")
                    return 2
                }
                duration = parsed
            case "--pid":
                index += 1
                guard index < argv.count, let parsed = pid_t(argv[index]) else {
                    print("focus-events: --pid needs a pid")
                    return 2
                }
                targetPID = parsed
            case "--all-subtypes":
                allSubtypes = true
            case "--raw":
                dumpRawFields = true
            case "--help", "-h":
                print(usage)
                return 0
            default:
                print("focus-events: unknown flag \(flag)\n\n\(usage)")
                return 2
            }
            index += 1
        }

        ApplicationRegistrySPI.establishWindowServerConnection()

        let tap = EventTap(
            eventTypes: CPSNotification.eventTypeMask,
            location: targetPID.map(EventTap.Location.pid) ?? .annotatedSession,
            placement: .tailAppendEventTap,
            // Listen-only: a diagnostic must not be able to eat real input.
            options: .listenOnly
        )

        var seen = 0
        let table = ProcessTable()
        let started = installed(
            table: table,
            tap: tap,
            allSubtypes: allSubtypes,
            dumpRawFields: dumpRawFields
        ) { seen += 1 }
        guard started else {
            print("""
            focus-events: could not create the event tap.

            A tap on this event type needs Accessibility (and on some systems
            Input Monitoring) for the binary running it. Grant it in
            System Settings → Privacy & Security, then retry.
            """)
            return 1
        }

        let scope = targetPID.map { "pid \($0)" } ?? "session"
        print("focus-events: tapping CPS notifications (1 << 21) on \(scope); Ctrl-C to stop")

        let deadline = duration.map { Date(timeIntervalSinceNow: $0) } ?? Date.distantFuture
        while Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.2))
        }
        tap.stopMonitoring()

        print("focus-events: \(seen) notification(s) observed")
        return 0
    }

    private static func installed(
        table: ProcessTable,
        tap: EventTap,
        allSubtypes: Bool,
        dumpRawFields: Bool,
        onEvent: @escaping () -> Void
    ) -> Bool {
        tap.startMonitoring { _, event in
            guard let observation = CPSNotification.observe(event) else {
                return event
            }
            if allSubtypes || observation.matchedSubtype != nil {
                onEvent()
                print(render(observation))
                if dumpRawFields {
                    print(renderRawFields(event, table: table))
                }
            }
            return event
        }
    }

    /// Dumps every integer field that carries a value, annotating any value
    /// that can be recognised.
    ///
    /// Identifying a field by eye means guessing; annotating each value
    /// against the live pid/PSN/subtype tables means reading it off. That
    /// difference is the whole reason this command exists.
    private static func renderRawFields(_ event: CGEvent, table: ProcessTable) -> String {
        var parts: [String] = []
        for raw in 0..<Int(256) {
            guard let field = CGEventField(rawValue: UInt32(raw)) else {
                continue
            }
            let value = event.getIntegerValueField(field)
            guard value != 0 else {
                continue
            }
            let annotation = table.annotate(value).map { "‹\($0)›" } ?? ""
            parts.append(String(format: "f%d=0x%lX%@", raw, value, annotation as NSString))
        }
        return "    raw: " + (parts.isEmpty ? "(all zero)" : parts.joined(separator: " "))
    }

    /// Live lookup from a raw field value to something meaningful.
    public struct ProcessTable {
        private var byPID: [Int64: String] = [:]
        private var byProcessSerialNumber: [Int64: String] = [:]

        public init() {
            for application in NSWorkspace.shared.runningApplications {
                let pid = application.processIdentifier
                guard pid > 0 else {
                    continue
                }
                let name = application.localizedName ?? application.bundleIdentifier ?? "pid \(pid)"
                byPID[Int64(pid)] = name
                if let psn = ApplicationRegistrySPI.serialNumber(for: pid) {
                    byProcessSerialNumber[Int64(psn.low)] = name
                }
            }
        }

        public func annotate(_ value: Int64) -> String? {
            if let subtype = Int32(exactly: value),
               let known = CPSNotification.Subtype(rawValue: subtype) {
                return "SUBTYPE \(known)"
            }
            if let name = byPID[value] {
                return "pid \(name)"
            }
            if let name = byProcessSerialNumber[value] {
                return "psn \(name)"
            }
            return nil
        }
    }

    private static func render(_ observation: CPSNotification.Observation) -> String {
        let name = observation.matchedSubtype.map(String.init(describing:)) ?? "unmatched"
        let source = observation.sourcePID.map { pid -> String in
            let process = NSRunningApplication(processIdentifier: pid)
            return "\(process?.localizedName ?? "?")(\(pid))"
        } ?? "-"
        return String(
            format: "subtype?=0x%04lX %-16@ process?=0x%lX source=%@",
            observation.subtypeCandidate,
            name as NSString,
            observation.subjectSerialNumber ?? 0,
            source as NSString
        )
    }
}
