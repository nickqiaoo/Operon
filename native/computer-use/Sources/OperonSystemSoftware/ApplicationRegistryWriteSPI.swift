import AppKit
import CoreGraphics
import Foundation

/// Options for `_SLPSSetFrontProcessWithOptions`.
///
/// The raw values were established by observing the reference implementation
/// (26.715.1000451) and match the historical `kCPS*` constants.
///
/// `noWindows` makes the target the front process **without ordering or
/// raising any of its windows**.
///
/// Measured on macOS 26.1: this really does leave the target's windows where
/// they are, but it still moves `NSWorkspace.frontmostApplication` — the menu
/// bar changes and every other app is told. So it is **not** by itself a way to
/// operate an app in the background, and the official `enforceActiveState`
/// does not use it: that posts `SynthesizedEvent`s straight to the target
/// instead. Kept because an explicit "bring this app to front" action still
/// needs it.
public struct SetFrontProcessOptions: OptionSet, Sendable {
    public let rawValue: UInt32

    public init(rawValue: UInt32) {
        self.rawValue = rawValue
    }

    /// `kCPSAllWindows` — bring every window of the target forward.
    public static let allWindows = SetFrontProcessOptions(rawValue: 0x100)
    /// `kCPSUserGenerated` — mark the change as user-initiated.
    public static let causedByUser = SetFrontProcessOptions(rawValue: 0x200)
    /// `kCPSNoWindows` — activate without touching window ordering.
    public static let noWindows = SetFrontProcessOptions(rawValue: 0x400)
    /// Leave a hidden application hidden.
    public static let dontUnhide = SetFrontProcessOptions(rawValue: 0x800)

    /// Activate without disturbing window ordering. Note this still changes the
    /// visible frontmost application; it is not a background activation.
    public static let withoutRaisingWindows: SetFrontProcessOptions = [.noWindows, .causedByUser]
}

private typealias SetFrontProcessFunction =
    @convention(c) (UnsafeMutableRawPointer, UInt32, UInt32) -> Int32

extension ApplicationRegistrySPI {
    /// The three-argument `(psn, windowID, options)` form. The leading
    /// underscore spelling is the one every public account of this SPI uses
    /// with this signature, so it is tried first; the others are fallbacks in
    /// case a future release only keeps one alias.
    private static let setFrontProcessWithOptions = DynamicSymbol.function(
        [
            "_SLPSSetFrontProcessWithOptions",
            "SLPSSetFrontProcessWithOptions",
            "CPSSetFrontProcessWithOptions",
        ],
        as: SetFrontProcessFunction.self
    )

    public static var canSetFrontProcess: Bool {
        setFrontProcessWithOptions != nil
    }

    /// Makes `psn` the CPS front process.
    ///
    /// Returns the raw `CGError`, or `nil` when the symbol could not be
    /// resolved at all — callers must treat that as "background activation is
    /// unavailable on this system" rather than falling back to a foreground
    /// steal.
    @discardableResult
    public static func setFrontProcess(
        _ psn: CPSProcessSerialNumber,
        windowID: UInt32 = 0,
        options: SetFrontProcessOptions
    ) -> Int32? {
        guard let setFrontProcessWithOptions else {
            return nil
        }
        var mutablePSN = psn
        return withUnsafeMutablePointer(to: &mutablePSN) {
            setFrontProcessWithOptions(
                UnsafeMutableRawPointer($0),
                windowID,
                options.rawValue
            )
        }
    }

    /// Confirms the write ABI without disturbing anything.
    ///
    /// The call targets whichever process is *already* front, so a correctly
    /// interpreted signature is a no-op and an incorrectly interpreted one
    /// cannot hand the foreground to some unrelated app. A non-zero `CGError`
    /// or an unresolved symbol both mean the write path must not be trusted.
    public static func verifySetFrontProcessSignature() -> Result<Void, WriteSPIError> {
        guard canSetFrontProcess else {
            return .failure(.symbolUnavailable)
        }
        establishWindowServerConnection()
        guard let frontPID = NSWorkspace.shared.frontmostApplication?.processIdentifier,
              let psn = serialNumber(for: frontPID)
        else {
            return .failure(.noFrontProcess)
        }
        guard let status = setFrontProcess(
            psn,
            windowID: 0,
            options: .withoutRaisingWindows
        ) else {
            return .failure(.symbolUnavailable)
        }
        guard status == 0 else {
            return .failure(.callFailed(status))
        }
        return .success(())
    }

    public enum WriteSPIError: Error, Equatable, CustomStringConvertible {
        case symbolUnavailable
        case noFrontProcess
        case callFailed(Int32)

        public var description: String {
            switch self {
            case .symbolUnavailable:
                return "_SLPSSetFrontProcessWithOptions could not be resolved"
            case .noFrontProcess:
                return "no frontmost application to verify against"
            case let .callFailed(status):
                return "_SLPSSetFrontProcessWithOptions returned CGError \(status)"
            }
        }
    }
}

public extension NSRunningApplication {
    /// Mirrors the official service's `setFrontProcess(windowID:options:)`.
    @discardableResult
    func setFrontProcess(
        windowID: UInt32 = 0,
        options: SetFrontProcessOptions
    ) -> Bool {
        guard let psn = ApplicationRegistrySPI.serialNumber(for: processIdentifier) else {
            return false
        }
        return ApplicationRegistrySPI.setFrontProcess(
            psn,
            windowID: windowID,
            options: options
        ) == 0
    }
}
