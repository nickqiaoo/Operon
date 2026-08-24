import CoreGraphics
import Foundation
import ScreenCaptureKit

/// Screen Recording (TCC) gate shared by the model screenshot path and the PiP
/// producer.
///
/// [operon] Without this gate a denied grant is expensive and silent: the
/// ScreenCaptureKit reply never arrives, every caller blocks for its full
/// timeout (5s on the snapshot path), and the framework logs a leaked
/// continuation. The host then sees empty screenshots and an empty PiP with no
/// stated reason.
///
/// Preflight alone is not enough. `CGPreflightScreenCaptureAccess` can report a
/// grant that the capture path does not honour — a rebuilt binary is a new TCC
/// identity while the old approval row still exists — so an observed refusal
/// from ScreenCaptureKit counts too, and it wins for a short cooldown.
public enum ScreenRecordingAccess {
    private static let lock = NSLock()
    /// Retry after this long: the user may have just fixed the grant.
    private static let denialCooldown: TimeInterval = 10
    /// All three are guarded by `lock`; the compiler cannot see that.
    nonisolated(unsafe) private static var prompted = false
    nonisolated(unsafe) private static var deniedAtUptime: TimeInterval?

    public static var isGranted: Bool {
        guard CGPreflightScreenCaptureAccess() else { return false }
        return lock.withLock { () -> Bool in
            guard let deniedAtUptime else { return true }
            if ProcessInfo.processInfo.systemUptime - deniedAtUptime < denialCooldown {
                return false
            }
            // Cooldown is over — let exactly one attempt through to re-test.
            Self.deniedAtUptime = nil
            return true
        }
    }

    /// ScreenCaptureKit itself refused. Believe it over preflight.
    public static func noteCaptureDenied() {
        lock.withLock { deniedAtUptime = ProcessInfo.processInfo.systemUptime }
    }

    /// A capture came back — whatever preflight thinks, we are allowed.
    public static func noteCaptureAllowed() {
        lock.withLock { deniedAtUptime = nil }
    }

    /// True for the TCC refusal ScreenCaptureKit reports (`userDeclined`).
    public static func isUserDeclined(_ error: Error) -> Bool {
        let nsError = error as NSError
        return nsError.code == SCStreamError.Code.userDeclined.rawValue
    }

    /// Show the system prompt at most once per process.
    ///
    /// macOS only prompts while the grant is still undecided; once the user has
    /// denied it — or the binary was rebuilt and lost its old grant — the only
    /// way back is System Settings, which the host UI offers separately.
    public static func promptOnce() {
        let shouldPrompt = lock.withLock { () -> Bool in
            guard !prompted else { return false }
            prompted = true
            return true
        }
        guard shouldPrompt else { return }
        // Off the calling thread: the request can put up UI.
        DispatchQueue.global(qos: .userInitiated).async {
            _ = CGRequestScreenCaptureAccess()
        }
    }
}
