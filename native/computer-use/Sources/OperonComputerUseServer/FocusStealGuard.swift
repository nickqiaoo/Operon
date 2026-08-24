import AppKit
import Foundation
import OpenComputerUseKit

func shouldRestoreForeground(
    previousPID: pid_t?,
    targetBundleIdentifier: String,
    currentFrontmostBundleIdentifier: String?,
    userIntervened: Bool
) -> Bool {
    previousPID != nil
        && currentFrontmostBundleIdentifier == targetBundleIdentifier
        && !userIntervened
}

/// Legacy "steal then restore" guard. Codex never does this: synthetic focus is
/// posted with `postToPid` so the system front process never moves.
///
/// Kept as a pure passthrough so old call sites compile; do not reintroduce
/// activate-based restoration on the product path.
enum FocusStealGuard {
    static func perform<T>(app: String, operation: () throws -> T) rethrows -> T {
        _ = app
        return try operation()
    }
}
