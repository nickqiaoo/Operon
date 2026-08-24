import AppKit
import Foundation

/// The 8-byte Carbon process identifier that the CPS/SkyLight focus SPI speaks.
public struct CPSProcessSerialNumber: Equatable, Hashable, Codable, Sendable {
    public var high: UInt32
    public var low: UInt32

    public init(high: UInt32 = 0, low: UInt32 = 0) {
        self.high = high
        self.low = low
    }

    public var isNull: Bool {
        high == 0 && low == 0
    }
}

// The out-parameters are declared raw because `@convention(c)` only accepts
// Objective-C representable types, which a Swift struct pointer is not. The
// call sites narrow them back at the boundary.
private typealias PSNOutFunction =
    @convention(c) (UnsafeMutableRawPointer) -> Int32
private typealias KeyFocusFunction =
    @convention(c) (UnsafeMutableRawPointer, UnsafeMutableRawPointer) -> Int32
private typealias FindByPIDFunction =
    @convention(c) (Int32, UnsafeMutableRawPointer) -> Int32
private typealias MainConnectionIDFunction =
    @convention(c) () -> Int32

/// Read-only half of the CPS process registry: who is front, who holds key
/// focus, and how a pid maps onto a serial number.
///
/// Everything here is resolved by name at runtime. `availability` reports what
/// actually resolved *and* passed its self-check, so a caller can degrade to the
/// fields it still trusts rather than reporting confident nonsense.
public enum ApplicationRegistrySPI {
    public struct Availability: Equatable {
        public var canResolveSerialNumbers = false
        public var canReadFrontProcess = false
        public var canReadKeyFocusProcess = false
        public var notes: [String] = []

        public init() {}

        public var isFullyAvailable: Bool {
            canResolveSerialNumbers && canReadFrontProcess && canReadKeyFocusProcess
        }
    }

    private static let mainConnectionID = DynamicSymbol.function(
        ["CGSMainConnectionID"],
        as: MainConnectionIDFunction.self
    )
    private static let getFrontProcess = DynamicSymbol.function(
        ["SLPSGetFrontProcess", "CPSGetFrontProcess"],
        as: PSNOutFunction.self
    )
    private static let getKeyFocusProcess = DynamicSymbol.function(
        ["SLPSGetKeyFocusProcess", "CPSGetKeyFocusProcess"],
        as: KeyFocusFunction.self
    )
    private static let findProcessByPID = DynamicSymbol.function(
        ["SLPSFindProcessByPID", "CPSFindProcessByPID"],
        as: FindByPIDFunction.self
    )

    /// Opens this process's WindowServer connection.
    ///
    /// Measured on macOS 26.1: a plain CLI gets `kCGErrorInvalidContext` (1003)
    /// from `SLPSGetKeyFocusProcess` until this has been called once, after
    /// which it succeeds. `SLPSGetFrontProcess` works either way. This is why
    /// the official service links `_CGSMainConnectionID` directly.
    @discardableResult
    public static func establishWindowServerConnection() -> Int32? {
        mainConnectionID.map { $0() }
    }

    /// `SLPSFindProcessByPID` answers a yes/no question and returns non-zero
    /// when it found the process — the opposite of the `CGError` convention the
    /// other calls here use. Both are checked against the filled-in serial
    /// number so a convention change cannot silently produce a null result.
    public static func serialNumber(for pid: pid_t) -> CPSProcessSerialNumber? {
        guard let findProcessByPID else {
            return nil
        }
        var psn = CPSProcessSerialNumber()
        let found = withUnsafeMutablePointer(to: &psn) {
            findProcessByPID(pid, UnsafeMutableRawPointer($0))
        }
        guard found != 0, !psn.isNull else {
            return nil
        }
        return psn
    }

    public static func frontProcess() -> CPSProcessSerialNumber? {
        guard let getFrontProcess else {
            return nil
        }
        var psn = CPSProcessSerialNumber()
        let status = withUnsafeMutablePointer(to: &psn) {
            getFrontProcess(UnsafeMutableRawPointer($0))
        }
        guard status == 0, !psn.isNull else {
            return nil
        }
        return psn
    }

    public struct KeyFocus: Equatable {
        public var process: CPSProcessSerialNumber
        /// The `Boolean` out-parameter the SPI fills alongside the serial
        /// number. Recorded verbatim; its meaning is not yet confirmed.
        public var flag: Bool
    }

    public static func keyFocusProcess() -> KeyFocus? {
        guard let getKeyFocusProcess else {
            return nil
        }
        var psn = CPSProcessSerialNumber()
        var flag: UInt8 = 0
        let status = withUnsafeMutablePointer(to: &psn) { psnPointer in
            withUnsafeMutablePointer(to: &flag) { flagPointer in
                getKeyFocusProcess(
                    UnsafeMutableRawPointer(psnPointer),
                    UnsafeMutableRawPointer(flagPointer)
                )
            }
        }
        guard status == 0, !psn.isNull else {
            return nil
        }
        return KeyFocus(process: psn, flag: flag != 0)
    }

    /// Validates the undocumented ABI before any of it is trusted.
    ///
    /// These routines have no header, so a wrong argument order or return
    /// convention would otherwise surface as plausible-looking garbage. The
    /// check that actually proves both directions is a triangle: AppKit says
    /// pid P is frontmost, `findProcessByPID(P)` must produce some serial
    /// number, and `getFrontProcess()` must independently produce the same one.
    public static func probeAvailability() -> Availability {
        var availability = Availability()
        establishWindowServerConnection()

        guard let frontPID = NSWorkspace.shared.frontmostApplication?.processIdentifier else {
            availability.notes.append("no frontmost application; SPI self-check skipped")
            return availability
        }
        guard let resolved = serialNumber(for: frontPID) else {
            availability.notes.append(
                "SLPSFindProcessByPID returned nothing for the frontmost pid; pid resolution disabled"
            )
            return availability
        }
        guard let front = frontProcess() else {
            availability.notes.append("SLPSGetFrontProcess unavailable; pid resolution disabled")
            return availability
        }
        guard front == resolved else {
            availability.notes.append(
                "SLPSGetFrontProcess and SLPSFindProcessByPID disagree at startup; readings disabled"
            )
            return availability
        }

        availability.canResolveSerialNumbers = true
        availability.canReadFrontProcess = true

        if keyFocusProcess() != nil {
            availability.canReadKeyFocusProcess = true
        } else {
            availability.notes.append(
                "SLPSGetKeyFocusProcess unavailable even after opening a WindowServer connection"
            )
        }

        return availability
    }
}

/// Caches pid ↔ serial-number pairs so a 100 Hz sampler does not rebuild the
/// mapping on every tick. Serial numbers are stable for a process's lifetime,
/// so the cache only has to grow when an unknown one shows up.
public final class ProcessSerialNumberResolver {
    private var pidByProcess: [CPSProcessSerialNumber: pid_t] = [:]
    private var knownPIDs: Set<pid_t> = []

    public init() {}

    public func pid(for psn: CPSProcessSerialNumber) -> pid_t? {
        if let pid = pidByProcess[psn] {
            return pid
        }
        refresh()
        return pidByProcess[psn]
    }

    /// Adds any running application not seen before. Called only on a cache
    /// miss, which in practice means once per newly-focused process.
    public func refresh() {
        for application in NSWorkspace.shared.runningApplications {
            let pid = application.processIdentifier
            guard pid > 0, !knownPIDs.contains(pid) else {
                continue
            }
            knownPIDs.insert(pid)
            if let psn = ApplicationRegistrySPI.serialNumber(for: pid) {
                pidByProcess[psn] = pid
            }
        }
    }
}
