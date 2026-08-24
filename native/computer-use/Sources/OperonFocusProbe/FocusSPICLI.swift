import AppKit
import Foundation
import OperonSystemSoftware

/// `operon-computer-use focus-spi`
///
/// Reports which CPS/SkyLight entry points resolved and which of them passed a
/// self-check. Phase 1 exists to make this boring and explicit, so that later
/// phases can assume the layer under them is either trustworthy or loudly
/// unavailable — never quietly wrong.
public enum FocusSPICLI {
    public static let usage = """
    usage: operon-computer-use focus-spi [--verify-write]

      --verify-write   also exercise _SLPSSetFrontProcessWithOptions against the
                       process that is already frontmost. This is a no-op when
                       the signature is interpreted correctly and cannot hand
                       the foreground to any other app, but it does call a
                       private write API — so it is opt-in.
      --help

    Exit code is 1 if anything required is unavailable or failed its check.
    """

    public static func run(_ argv: [String]) -> Int32 {
        var verifyWrite = false
        for flag in argv {
            switch flag {
            case "--verify-write":
                verifyWrite = true
            case "--help", "-h":
                print(usage)
                return 0
            default:
                print("focus-spi: unknown flag \(flag)\n\n\(usage)")
                return 2
            }
        }

        var lines: [String] = ["── focus-spi ──"]
        var healthy = true

        let connection = ApplicationRegistrySPI.establishWindowServerConnection()
        lines.append("CGSMainConnectionID: \(connection.map(String.init) ?? "unavailable")")
        if connection == nil {
            healthy = false
        }

        let availability = ApplicationRegistrySPI.probeAvailability()
        lines.append("read side:")
        lines.append("  serial numbers  : \(mark(availability.canResolveSerialNumbers))")
        lines.append("  front process   : \(mark(availability.canReadFrontProcess))")
        lines.append("  key focus       : \(mark(availability.canReadKeyFocusProcess))")
        for note in availability.notes {
            lines.append("  ! \(note)")
        }
        if !availability.isFullyAvailable {
            healthy = false
        }

        if let frontPID = NSWorkspace.shared.frontmostApplication?.processIdentifier {
            let psn = ApplicationRegistrySPI.serialNumber(for: frontPID)
            lines.append(
                "  frontmost pid \(frontPID) → psn "
                    + (psn.map { "(\($0.high), \($0.low))" } ?? "unresolved")
            )
        }

        lines.append("write side:")
        lines.append("  _SLPSSetFrontProcessWithOptions: \(mark(ApplicationRegistrySPI.canSetFrontProcess))")
        if !ApplicationRegistrySPI.canSetFrontProcess {
            healthy = false
        }
        lines.append("  option raw values: " + [
            "allWindows=0x\(String(SetFrontProcessOptions.allWindows.rawValue, radix: 16))",
            "causedByUser=0x\(String(SetFrontProcessOptions.causedByUser.rawValue, radix: 16))",
            "noWindows=0x\(String(SetFrontProcessOptions.noWindows.rawValue, radix: 16))",
            "dontUnhide=0x\(String(SetFrontProcessOptions.dontUnhide.rawValue, radix: 16))",
        ].joined(separator: " "))

        if verifyWrite {
            switch ApplicationRegistrySPI.verifySetFrontProcessSignature() {
            case .success:
                lines.append("  signature self-check: ok (no-op against the already-front process)")
            case let .failure(error):
                lines.append("  signature self-check: FAILED — \(error)")
                healthy = false
            }
        } else {
            lines.append("  signature self-check: skipped (pass --verify-write)")
        }

        lines.append(healthy ? "all required SPI available" : "SPI incomplete — background focus would degrade")
        print(lines.joined(separator: "\n"))
        return healthy ? 0 : 1
    }

    private static func mark(_ value: Bool) -> String {
        value ? "ok" : "UNAVAILABLE"
    }
}
