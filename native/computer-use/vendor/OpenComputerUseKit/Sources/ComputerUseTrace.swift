import Foundation

/// Timestamped tracing for the action path.
///
/// Uses `systemUptime` so a trace line can be lined up directly against the
/// foreground sampler in `focus-endtoend`, which timestamps the same way. That
/// correlation is the only way to say which call raised the window rather than
/// guessing from the shape of the code.
///
/// Off unless `OPERON_CU_TRACE=1`.
public enum ComputerUseTrace {
    public static let isEnabled = ProcessInfo.processInfo
        .environment["OPERON_CU_TRACE"] == "1"

    public static func mark(_ label: @autoclosure () -> String) {
        guard isEnabled else {
            return
        }
        let uptime = ProcessInfo.processInfo.systemUptime
        FileHandle.standardError.write(
            Data(String(format: "[trace %.3f] %@\n", uptime, label()).utf8)
        )
    }

    @discardableResult
    public static func measure<T>(
        _ label: String,
        _ body: () throws -> T
    ) rethrows -> T {
        guard isEnabled else {
            return try body()
        }
        mark("\(label) BEGIN")
        defer { mark("\(label) END") }
        return try body()
    }
}
