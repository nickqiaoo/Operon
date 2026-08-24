import AppKit
import Foundation
import OperonSystemSoftware

/// `operon-computer-use focus-probe [options]`
///
/// Streams the foreground timeline as JSONL and prints a verdict on exit.
public enum FocusProbeCLI {
    public struct Arguments {
        public var options = FocusProbe.Options()
        public var outputPath: String?
        public var baselinePID: pid_t?
        public var showHelp = false
    }

    public static let usage = """
    usage: operon-computer-use focus-probe [options]

      --interval-ms <n>   sampling interval, default 10
      --duration <s>      stop after s seconds; omit to run until Ctrl-C
      --out <path>        write JSONL here instead of stdout
      --baseline <pid>    pid that must stay in the foreground the whole time;
                          defaults to whatever is frontmost at startup
      --all               emit every sample, not only transitions
      --help

    Emits one JSON line per foreground transition, then a summary on stderr.
    Exit code is 1 if the foreground ever left the baseline.
    """

    public static func parse(_ argv: [String]) throws -> Arguments {
        var arguments = Arguments()
        var index = 0

        func value(_ flag: String) throws -> String {
            index += 1
            guard index < argv.count else {
                throw ProbeError.missingValue(flag)
            }
            return argv[index]
        }

        while index < argv.count {
            let flag = argv[index]
            switch flag {
            case "--interval-ms":
                guard let parsed = Double(try value(flag)), parsed > 0 else {
                    throw ProbeError.invalidValue(flag)
                }
                arguments.options.intervalMilliseconds = parsed
            case "--duration":
                guard let parsed = Double(try value(flag)), parsed > 0 else {
                    throw ProbeError.invalidValue(flag)
                }
                arguments.options.durationSeconds = parsed
            case "--out":
                arguments.outputPath = try value(flag)
            case "--baseline":
                guard let parsed = pid_t(try value(flag)) else {
                    throw ProbeError.invalidValue(flag)
                }
                arguments.baselinePID = parsed
            case "--all":
                arguments.options.emitEverySample = true
            case "--help", "-h":
                arguments.showHelp = true
            default:
                throw ProbeError.unknownFlag(flag)
            }
            index += 1
        }
        return arguments
    }

    public enum ProbeError: Error, CustomStringConvertible {
        case missingValue(String)
        case invalidValue(String)
        case unknownFlag(String)

        public var description: String {
            switch self {
            case let .missingValue(flag):
                return "\(flag) needs a value"
            case let .invalidValue(flag):
                return "\(flag) got an invalid value"
            case let .unknownFlag(flag):
                return "unknown flag \(flag)"
            }
        }
    }

    /// Returns the process exit code.
    public static func run(_ argv: [String]) -> Int32 {
        let arguments: Arguments
        do {
            arguments = try parse(argv)
        } catch {
            FileHandle.standardError.write(Data("focus-probe: \(error)\n\n\(usage)\n".utf8))
            return 2
        }

        if arguments.showHelp {
            print(usage)
            return 0
        }

        let baseline = arguments.baselinePID
            ?? NSWorkspace.shared.frontmostApplication?.processIdentifier
        let sink = OutputSink(path: arguments.outputPath)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]

        let stopped = Interrupted()
        let signalSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
        signalSource.setEventHandler { stopped.set() }
        signal(SIGINT, SIG_IGN)
        signalSource.resume()

        let probe = FocusProbe(options: arguments.options)
        let banner = "focus-probe: sampling every \(arguments.options.intervalMilliseconds)ms"
            + ", baseline pid \(baseline.map(String.init) ?? "none")\n"
        FileHandle.standardError.write(Data(banner.utf8))

        let result = probe.run(shouldStop: { stopped.isSet }) { record in
            guard let line = try? encoder.encode(record) else {
                return
            }
            sink.write(line)
        }
        signalSource.cancel()
        sink.close()

        return report(
            probe: probe,
            records: result.records,
            totalMilliseconds: result.totalMilliseconds,
            baseline: baseline
        )
    }

    private static func report(
        probe: FocusProbe,
        records: [FocusRecord],
        totalMilliseconds: Double,
        baseline: pid_t?
    ) -> Int32 {
        var lines: [String] = ["", "── focus-probe summary ──"]
        lines.append(
            String(
                format: "duration %.1fs, %d samples, %d transitions",
                totalMilliseconds / 1000,
                probe.totalSamples,
                records.count
            )
        )

        if !probe.availability.isFullyAvailable {
            lines.append("degraded readings:")
            for note in probe.availability.notes {
                lines.append("  ! \(note)")
            }
        }

        let fields: [(String, KeyPath<FocusSignature, pid_t?>)] = [
            ("workspaceFront", \.workspaceFrontPID),
            ("cpsFront", \.cpsFrontPID),
            ("keyFocus", \.keyFocusPID),
            ("topWindow", \.topWindowPID),
        ]
        let allNames = records.reduce(into: [String: String]()) { $0.merge($1.names) { a, _ in a } }

        for (label, field) in fields {
            let episodes = FocusProbeReport.episodes(
                in: records,
                totalMilliseconds: totalMilliseconds,
                field: field
            )
            let rendered = episodes.map { episode -> String in
                let pid = episode.pid.map(String.init) ?? "-"
                let name = episode.pid.flatMap { allNames[String($0)] } ?? "unknown"
                return String(format: "%@(%@) %.0fms", name, pid, episode.durationMilliseconds)
            }
            lines.append("  \(label): \(rendered.isEmpty ? "no data" : rendered.joined(separator: " → "))")
        }

        guard let baseline else {
            lines.append("no baseline pid; foreground assertion skipped")
            FileHandle.standardError.write(Data((lines.joined(separator: "\n") + "\n").utf8))
            return 0
        }

        let foreign = FocusProbeReport.foreignForegroundEpisodes(
            in: records,
            totalMilliseconds: totalMilliseconds,
            baselinePID: baseline
        )
        if foreign.isEmpty {
            lines.append("PASS: foreground stayed on pid \(baseline) for the whole run")
        } else {
            lines.append("FAIL: foreground left pid \(baseline) \(foreign.count) time(s)")
            for episode in foreign.prefix(20) {
                let name = episode.pid.flatMap { allNames[String($0)] } ?? "unknown"
                lines.append(
                    String(
                        format: "  at %.0fms for %.0fms → %@(%@)",
                        episode.startMilliseconds,
                        episode.durationMilliseconds,
                        name,
                        episode.pid.map(String.init) ?? "-"
                    )
                )
            }
        }

        FileHandle.standardError.write(Data((lines.joined(separator: "\n") + "\n").utf8))
        return foreign.isEmpty ? 0 : 1
    }
}

private final class Interrupted: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    var isSet: Bool {
        lock.withLock { value }
    }

    func set() {
        lock.withLock { value = true }
    }
}

private final class OutputSink {
    private let handle: FileHandle
    private let shouldClose: Bool

    init(path: String?) {
        guard let path else {
            handle = FileHandle.standardOutput
            shouldClose = false
            return
        }
        FileManager.default.createFile(atPath: path, contents: nil)
        handle = FileHandle(forWritingAtPath: path) ?? FileHandle.standardOutput
        shouldClose = true
    }

    func write(_ line: Data) {
        handle.write(line)
        handle.write(Data("\n".utf8))
    }

    func close() {
        if shouldClose {
            try? handle.close()
        }
    }
}
