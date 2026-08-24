import AppKit
import CoreGraphics
import Foundation
import OperonAccessibilitySupport
import OperonComputerUseServer
import OperonComputerUseWire
import OpenComputerUseKit
import OperonSystemSoftware

/// `operon-computer-use focus-endtoend --app <name>`
///
/// Drives the **real** wire path — the same `WireRouter` request the product
/// issues — while sampling the foreground, and reports whether anything moved.
///
/// Every isolated mechanism tested so far (synthetic activation, the vendored
/// click-pair sequence, AXRaise) leaves the foreground alone, so either the
/// flicker comes from somewhere else in the real path or from an interaction
/// between steps. Reimplementing the sequence would only re-test the parts
/// already cleared; this runs the actual router, `FocusStealGuard` included.
///
/// Read-only: it issues `getSkyshot` (get_app_state), never an action, so it
/// cannot click anything in the user's applications.
public enum FocusEndToEndCLI {
    public static let usage = """
    usage: operon-computer-use focus-endtoend --app <name-or-bundle-id> [--rounds <n>]

      --app <name>   application to read state for. Required.
      --rounds <n>   how many get_app_state requests, default 3
      --enforce      assert synthetic focus with SyntheticAppFocusEnforcer before
                     the click, using the correct KeyFocusReturned subtype
      --click <idx>  after reading state, issue a real performAction click on
                     this element index. This mutates the target application —
                     only pass an index that is idempotent.
      --help

    Issues only read requests through the real WireRouter while watching the
    foreground. Exit code 1 if the foreground moved.
    """

    public static func run(_ argv: [String]) -> Int32 {
        var app: String?
        var rounds = 3
        var clickIndex: String?
        var enforceFirst = false
        var index = 0

        while index < argv.count {
            switch argv[index] {
            case "--app":
                index += 1
                guard index < argv.count else {
                    print("focus-endtoend: --app needs a value")
                    return 2
                }
                app = argv[index]
            case "--rounds":
                index += 1
                guard index < argv.count, let parsed = Int(argv[index]), parsed > 0 else {
                    print("focus-endtoend: --rounds needs a positive number")
                    return 2
                }
                rounds = parsed
            case "--enforce":
                enforceFirst = true
            case "--click":
                index += 1
                guard index < argv.count else {
                    print("focus-endtoend: --click needs an element index")
                    return 2
                }
                clickIndex = argv[index]
            case "--help", "-h":
                print(usage)
                return 0
            default:
                print("focus-endtoend: unknown flag \(argv[index])\n\n\(usage)")
                return 2
            }
            index += 1
        }

        guard let app else {
            print(usage)
            return 2
        }

        ApplicationRegistrySPI.establishWindowServerConnection()

        guard let baseline = waitForStableForeground() else {
            print("focus-endtoend: foreground never settled; retry when the desktop is idle")
            return 1
        }
        let baselineName = NSRunningApplication(processIdentifier: baseline)?
            .localizedName ?? String(baseline)
        print("""
        focus-endtoend
          baseline front : \(baselineName)(\(baseline))
          app            : \(app)
          request        : getSkyshot (read-only) x\(rounds)
        """)

        let targetPID = NSWorkspace.shared.runningApplications.first(where: {
            $0.localizedName == app
                || $0.bundleIdentifier == app
                || ($0.bundleIdentifier?.localizedCaseInsensitiveContains(app) ?? false)
                || ($0.localizedName?.localizedCaseInsensitiveContains(app) ?? false)
        })?.processIdentifier

        let router = WireRouter()

        if let clickIndex {
            return runClick(
                router: router,
                app: app,
                elementIndex: clickIndex,
                baseline: baseline,
                enforceFirst: enforceFirst
            )
        }

        guard let targetPID else {
            print("focus-endtoend: could not resolve a running pid for \(app)")
            return 1
        }

        var exitCode: Int32 = 0
        for round in 1...rounds {
            print("  --- round \(round)/\(rounds) ---")
            let code = instrumentedGetSkyshotFlashCheck(
                router: router,
                app: app,
                targetPID: targetPID,
                baseline: baseline,
                priorRounds: round
            )
            if code != 0 {
                exitCode = code
            }
        }
        return exitCode
    }

    /// Concurrent sampler + one getSkyshot; fails only if target pid becomes
    /// cps front or top-window owner.
    private static func instrumentedGetSkyshotFlashCheck(
        router: WireRouter,
        app: String,
        targetPID: pid_t,
        baseline: pid_t,
        priorRounds: Int
    ) -> Int32 {
        let resolver = ProcessSerialNumberResolver()
        resolver.refresh()
        let samples = SampleBuffer()
        let stop = AtomicFlag()
        let t0 = ProcessInfo.processInfo.systemUptime
        let sampler = Thread {
            while !stop.isSet {
                let cpsFront = ApplicationRegistrySPI.frontProcess()
                    .flatMap { resolver.pid(for: $0) }
                let topWindow = FocusProbe.frontmostWindowOwnerPID()
                samples.append((
                    (ProcessInfo.processInfo.systemUptime - t0) * 1000,
                    cpsFront,
                    topWindow
                ))
                Thread.sleep(forTimeInterval: 0.005)
            }
        }
        sampler.stackSize = 512 * 1024
        sampler.start()

        var textLines = 0
        var hydrated = false
        do {
            let result = try router.handle(
                method: "request",
                params: [
                    "requestType": RequestType.getSkyshot.rawValue,
                    "request": ["app": app, "disableDiff": true],
                ] as [String: Any]
            )
            if let dict = result as? [String: Any],
               let skyshot = dict["skyshot"] as? [String: Any],
               let text = skyshot["text"] as? String
            {
                textLines = text.split(separator: "\n", omittingEmptySubsequences: false).count
                hydrated = text.contains("HTML 内容")
                    || text.contains("会话列表")
                    || text.contains("AXWebArea")
                    || text.contains("HTML content")
            }
            print("  instrumented get_app_state: lines=\(textLines) hydrated=\(hydrated)")
        } catch {
            print("  instrumented get_app_state failed: \(error)")
            stop.set()
            return 1
        }

        Thread.sleep(forTimeInterval: 0.3)
        stop.set()
        Thread.sleep(forTimeInterval: 0.02)

        let rows = samples.all
        var targetHits: [(Double, pid_t?, pid_t?)] = []
        for row in rows {
            if row.1 == targetPID || row.2 == targetPID {
                targetHits.append(row)
            }
        }

        print("""
          samples=\(rows.count) targetHits=\(targetHits.count) \
        baseline=\(baseline) target=\(targetPID)
        """)
        if let first = targetHits.first {
            print(String(
                format: "  first target flash +%.0fms front=%@ top=%@",
                first.0,
                first.1.map(String.init) ?? "-",
                first.2.map(String.init) ?? "-"
            ))
        }

        if !hydrated {
            print("\nFAIL: AX tree did not hydrate (no HTML/会话列表)")
            return 1
        }
        if targetHits.isEmpty {
            print("\nPASS: QQ never became front/top; AX hydrated (\(textLines) lines)")
            return 0
        }
        print("\nFAIL: target flashed in \(targetHits.count) sample(s) during get_app_state")
        for (elapsed, workspace, topWindow) in targetHits.prefix(12) {
            print(String(
                format: "  +%.0fms workspaceFront=%@ topWindow=%@",
                elapsed,
                workspace.map(String.init) ?? "-",
                topWindow.map(String.init) ?? "-"
            ))
        }
        return 1
    }

    /// Samples the foreground *while* a real click request runs.
    ///
    /// The request blocks, so sampling happens on another thread — and that
    /// thread deliberately uses only direct WindowServer queries
    /// (`SLPSGetFrontProcess`, `CGWindowList`) rather than
    /// `NSWorkspace.frontmostApplication`, which is notification-backed and
    /// would report a frozen value without a run loop.
    private static func runClick(
        router: WireRouter,
        app: String,
        elementIndex: String,
        baseline: pid_t,
        enforceFirst: Bool
    ) -> Int32 {
        let resolver = ProcessSerialNumberResolver()
        resolver.refresh()

        // Judge on "did the target come forward", not "did the foreground
        // change". The user switching to some unrelated app is not this bug,
        // and an earlier version of this check counted it as a failure.
        guard let targetPID = NSWorkspace.shared.runningApplications.first(where: {
            $0.localizedName == app || $0.bundleIdentifier == app
        })?.processIdentifier else {
            print("focus-endtoend: could not resolve a pid for \(app)")
            return 1
        }

        // The baseline has to be read through the same lens as the samples.
        // Mixing NSWorkspace for the baseline with SLPSGetFrontProcess for the
        // samples made an earlier run report a steal that never happened.
        let sampledBaseline = ApplicationRegistrySPI.frontProcess()
            .flatMap { resolver.pid(for: $0) } ?? baseline
        let baselineWindow = FocusProbe.frontmostWindowOwnerPID() ?? sampledBaseline
        _ = sampledBaseline
        _ = baselineWindow

        let samples = SampleBuffer()
        let stop = AtomicFlag()
        let start = Date()

        let sampler = Thread {
            while !stop.isSet {
                let cpsFront = ApplicationRegistrySPI.frontProcess()
                    .flatMap { resolver.pid(for: $0) }
                let topWindow = FocusProbe.frontmostWindowOwnerPID()
                samples.append((ProcessInfo.processInfo.systemUptime * 1000, cpsFront, topWindow))
                Thread.sleep(forTimeInterval: 0.005)
            }
        }
        sampler.stackSize = 512 * 1024
        sampler.start()

        var enforcer: SyntheticAppFocusEnforcer?
        if enforceFirst {
            let targetPID = NSWorkspace.shared.runningApplications.first {
                $0.localizedName == app || $0.bundleIdentifier == app
            }?.processIdentifier
            if let targetPID {
                let created = SyntheticAppFocusEnforcer(pid: targetPID)
                let decision = created.enforceActiveState(
                    windowID: frontWindow(of: targetPID) ?? 0
                )
                enforcer = created
                print("  enforced focus on pid \(targetPID): \(decision)")
                Thread.sleep(forTimeInterval: 0.15)
            } else {
                print("  could not resolve target pid for --enforce")
            }
        }

        print("  issuing performAction click on element \(elementIndex) …")
        let clickStart = Date().timeIntervalSince(start) * 1000
        var failure: String?
        do {
            _ = try router.handle(
                method: "request",
                params: [
                    "requestType": RequestType.performAction.rawValue,
                    // Wire shape is the synthesized enum encoding, and the
                    // element id is a String — both pinned by SkyOracleTests.
                    "request": [
                        "app": app,
                        "action": [
                            "click": [
                                "at": ["elementID": ["_0": elementIndex]],
                                "clickCount": 1,
                                "mouseButton": 0,
                            ],
                        ],
                    ],
                ] as [String: Any]
            )
        } catch {
            failure = "\(error)"
        }
        let clickEnd = Date().timeIntervalSince(start) * 1000
        Thread.sleep(forTimeInterval: 0.6)
        stop.set()
        Thread.sleep(forTimeInterval: 0.05)

        enforcer?.deactivateFocusEnforcer()
        if let failure {
            print("  click failed: \(failure)")
        }
        print(String(format: "  click ran from +%.0fms to +%.0fms", clickStart, clickEnd))

        let recorded = samples.all
        var transitions: [(Double, pid_t?, pid_t?)] = []
        var previous: (pid_t?, pid_t?)?
        for sample in recorded {
            let key = (sample.1, sample.2)
            if previous == nil || previous! != key {
                transitions.append(sample)
                previous = key
            }
        }

        print("\nforeground timeline (\(recorded.count) samples @5ms, absolute uptime ms — same clock as [trace] lines):")
        for (elapsed, cpsFront, topWindow) in transitions {
            let name = cpsFront.flatMap {
                NSRunningApplication(processIdentifier: $0)?.localizedName
            } ?? "?"
            let marker = (cpsFront == targetPID || topWindow == targetPID) ? "*" : " "
            print(String(
                format: " %@ uptime=%.0f cpsFront=%@(%@) topWindow=%@",
                marker,
                elapsed,
                name as NSString,
                cpsFront.map(String.init) ?? "-",
                topWindow.map(String.init) ?? "-"
            ))
        }

        let stolen = recorded.filter { $0.1 == targetPID || $0.2 == targetPID }
        if stolen.isEmpty {
            print("\nPASS: \(app) never came to the foreground during the click")
            return 0
        }
        let first = stolen.first!.0
        let last = stolen.last!.0
        let cpsSteals = stolen.filter { $0.1 == targetPID }.count
        let windowRaises = stolen.filter { $0.2 == targetPID }.count
        print(String(
            format: "\nFAIL: %@ was in front for ~%.0fms (%d samples as front process, %d as top window)",
            app as NSString, last - first, cpsSteals, windowRaises
        ))
        return 1
    }

    private final class SampleBuffer: @unchecked Sendable {
        private let lock = NSLock()
        private var storage: [(Double, pid_t?, pid_t?)] = []

        func append(_ sample: (Double, pid_t?, pid_t?)) {
            lock.withLock { storage.append(sample) }
        }

        var all: [(Double, pid_t?, pid_t?)] {
            lock.withLock { storage }
        }
    }

    private final class AtomicFlag: @unchecked Sendable {
        private let lock = NSLock()
        private var value = false
        var isSet: Bool { lock.withLock { value } }
        func set() { lock.withLock { value = true } }
    }

    private static func frontWindow(of pid: pid_t) -> CGWindowID? {
        guard let infoList = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
        ) as? [[String: Any]] else {
            return nil
        }
        for info in infoList {
            guard let owner = info[kCGWindowOwnerPID as String] as? pid_t, owner == pid,
                  let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
                  let number = info[kCGWindowNumber as String] as? NSNumber
            else { continue }
            return CGWindowID(number.uint32Value)
        }
        return nil
    }

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
}
