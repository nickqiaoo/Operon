import Foundation
import Security
#if canImport(Darwin)
import Darwin
#endif

// A `<sys/un.h>` constant the Swift Darwin overlay does not always export; defined here from the
// header value as a fallback.
private let kSOL_LOCAL: Int32 = 0
private let kLOCAL_PEERTOKEN: Int32 = 0x006

/// codesign peer verification (server side): reads the codesign Team ID from the audit token of
/// the peer on the incoming socket and compares it to this process's own. Same policy as
/// `packages/browser-use/peer-auth.ts`:
///
/// - `OPERON_REQUIRE_SIGNED_PEER` unset → no check.
/// - no Team ID on self (dev / adhoc) → nothing to enforce against → warn and allow
///   (**never lock a developer out**).
/// - Team ID present on self (a signed release build) → enforce: reject any peer whose Team is
///   not on the allowlist.
///
/// The happy path can only be verified on a notarised build. This layers on top of the phase 1
/// startup token, giving two gates.
enum PeerAuth {
    private static let enableEnvKey = "OPERON_REQUIRE_SIGNED_PEER"
    private static let extraTeamsEnvKey = "OPERON_ALLOWED_PEER_TEAMS"

    private static let enabled: Bool =
        ProcessInfo.processInfo.environment[enableEnvKey]?.isEmpty == false

    /// The allowlist is this process's own Team ID plus anything extra configured. With no Team ID
    /// of our own (adhoc), this is nil and nothing can be enforced.
    private static let allowedTeams: Set<String>? = {
        guard let selfTeam = teamIdentifier(for: copySelfCode()) else { return nil }
        let extra = (ProcessInfo.processInfo.environment[extraTeamsEnvKey] ?? "")
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return Set([selfTeam] + extra)
    }()

    static func authorize(fd: Int32) -> Bool {
        guard enabled else { return true }
        guard let teams = allowedTeams else {
            warnOnce("unsigned-self",
                     "\(enableEnvKey) set but this build is unsigned (no Team ID); allowing (cannot enforce)")
            return true
        }
        guard let peerTeam = peerTeamIdentifier(fd: fd) else {
            log("rejected connection: peer has no team id")
            return false
        }
        if teams.contains(peerTeam) { return true }
        log("rejected connection: peer team \(peerTeam) not in allowlist")
        return false
    }

    // MARK: - SecCode

    private static func copySelfCode() -> SecCode? {
        var code: SecCode?
        guard SecCodeCopySelf(SecCSFlags(), &code) == errSecSuccess else { return nil }
        return code
    }

    private static func peerTeamIdentifier(fd: Int32) -> String? {
        var token = audit_token_t(val: (0, 0, 0, 0, 0, 0, 0, 0))
        var len = socklen_t(MemoryLayout<audit_token_t>.size)
        let rc = withUnsafeMutablePointer(to: &token) { ptr in
            getsockopt(fd, kSOL_LOCAL, kLOCAL_PEERTOKEN, ptr, &len)
        }
        guard rc == 0, Int(len) == MemoryLayout<audit_token_t>.size else { return nil }
        let data = withUnsafeBytes(of: token) { Data($0) } as CFData
        let attrs = [kSecGuestAttributeAudit: data] as CFDictionary
        var code: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, attrs, SecCSFlags(), &code) == errSecSuccess,
              let code
        else { return nil }
        return teamIdentifier(for: code)
    }

    private static func teamIdentifier(for code: SecCode?) -> String? {
        guard let code else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode) == errSecSuccess,
              let staticCode
        else { return nil }
        var info: CFDictionary?
        let flags = SecCSFlags(rawValue: kSecCSSigningInformation)
        guard SecCodeCopySigningInformation(staticCode, flags, &info) == errSecSuccess,
              let dict = info as? [String: Any]
        else { return nil }
        return dict[kSecCodeInfoTeamIdentifier as String] as? String
    }

    // MARK: - logging

    private static let warnLock = NSLock()
    // Guarded by warnLock. Swift 6 strict concurrency cannot see that, so say it explicitly.
    nonisolated(unsafe) private static var warned = Set<String>()
    private static func warnOnce(_ key: String, _ message: String) {
        warnLock.lock()
        defer { warnLock.unlock() }
        if warned.contains(key) { return }
        warned.insert(key)
        log(message)
    }

    private static func log(_ message: String) {
        FileHandle.standardError.write(Data("[operon-cu peer-auth] \(message)\n".utf8))
    }
}
