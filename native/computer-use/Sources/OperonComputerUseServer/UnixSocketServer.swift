import AppKit
import Foundation
import OperonComputerUseWire
#if canImport(Darwin)
import Darwin
#endif

/// Unix domain socket server: codex framing (4B LE length + JSON-RPC) plus routing.
///
/// **Connections are concurrent; request execution is serial.** Both halves are required:
///
/// - **Concurrent accept** (fixed 2026-07-17): this used to be a serial loop of `accept` →
///   `handleConnection` (blocking until the connection closed) → `accept` again, with a comment
///   claiming "v1 handles a single connection serially (one connection is all sky needs)".
///   But **sky's transport is long-lived, reused across calls and never closed by the client**,
///   while `ComputerUseService` is a **process-wide singleton shared across sessions** in operon
///   (`server/src/routes/node-repl-mcp.ts`), and each session's kernel opens its own connection.
///   So **every session after the first hung forever, with no error anywhere** (measured: the
///   second client's ping got no response in 5s). The "one connection is all it needs" premise
///   was wrong from the start.
///
/// - **Serial execution**: AX operations should happen one at a time and have always run on the
///   main thread. Fixing the connection bug was no reason to also change which thread they run
///   on, so requests still funnel back to the main queue — byte-for-byte the previous behaviour.
/// During `DispatchQueue.main.sync` the caller is **blocked**, so the value cannot be accessed
/// concurrently. Swift 6's region-based isolation cannot see that and flags a non-Sendable value
/// crossing the `sync` boundary as a data race; this box asserts the fact explicitly.
/// **Only valid with `sync`** — under `async` the promise would be a lie.
private final class SyncBox<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}

private struct ComputerUseControlError: LocalizedError {
    let errorDescription: String?
}

/// Every call into `router` happens on the main queue (see handleMessage), which is what makes
/// sharing self across threads safe.
public final class UnixSocketServer: @unchecked Sendable {
    private let path: String
    private let router: WireRouter
    /// The expected startup token. nil disables authentication (a direct dev or test connection
    /// still works); non-nil means every connection must send a matching `operon/authenticate`
    /// frame before its first real request, or it is closed and never routed.
    private let expectedToken: String?
    /// One concurrent task per connection, so connections never block each other.
    private let connectionQueue = DispatchQueue(
        label: "operon.computer-use.connections",
        attributes: .concurrent,
    )

    public init(path: String, router: WireRouter, expectedToken: String? = nil) {
        self.path = path
        self.router = router
        self.expectedToken = expectedToken
    }

    public enum ServerError: Swift.Error { case socket(String) }

    @MainActor
    public func run() throws {
        unlink(path) // clear a stale socket
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ServerError.socket("socket() errno=\(errno)") }
        defer { close(fd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        let pathBytes = Array(path.utf8)
        guard pathBytes.count < capacity else { throw ServerError.socket("socket path too long") }
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: capacity) { dst in
                for (i, b) in pathBytes.enumerated() { dst[i] = CChar(bitPattern: b) }
                dst[pathBytes.count] = 0
            }
        }

        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) }
        }
        guard bound == 0 else { throw ServerError.socket("bind() errno=\(errno)") }
        // Owner-only, since macOS requires write permission on the socket to connect — this is
        // what keeps another user from connecting directly. The host also places the socket in a
        // 0700 directory, so the two are belt and braces. Failure is not fatal; log the errno.
        if chmod(path, mode_t(0o600)) != 0 {
            log("chmod 0600 failed errno=\(errno)")
        }
        guard listen(fd, 8) == 0 else { throw ServerError.socket("listen() errno=\(errno)") }
        log("listening at \(path)")

        // The accept loop moves to the background: the OS main thread has to stay free for the
        // AppKit event loop (see below).
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            while true {
                let client = accept(fd, nil, nil)
                if client < 0 {
                    if errno == EINTR { continue }
                    break
                }
                disableSIGPIPE(on: client)
                // Each connection runs on its own, so one silent client cannot stall another session.
                connectionQueue.async { [self] in
                    handleConnection(client)
                    close(client)
                }
            }
        }

        // Never returns. This has to be a real AppKit event loop rather than `dispatchMain()`:
        //
        // in a command-line process, main-queue work can be executed by a libdispatch worker —
        // the queue label still reads `com.apple.main-thread` but `Thread.isMainThread` is false.
        // Most AX queries survive that, but the first time the virtual cursor constructs an
        // NSPanel, AppKit throws an Objective-C exception and the whole Swift service takes a
        // SIGABRT. All the client sees is `Sky Computer Use connection closed`.
        //
        // `.accessory` keeps the ability to show non-activating panels while keeping this
        // background service out of the Dock.
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        ComputerUsePresentationController.shared.start()
        UserInterruptionMonitor.shared.start()
        application.run()
    }

    /// **A client disconnecting early must not kill the whole service.**
    ///
    /// By default, `write()` to a closed socket delivers SIGPIPE, whose default disposition is to
    /// **terminate the process**
    /// Measured: a client sent a `click`, gave up after 3s (looking up a non-existent app takes
    /// ~5.3s) and disconnected; the server was killed as it wrote the response, exit code 141
    /// (128+13), and every request after that got ECONNREFUSED. One impatient client was enough
    /// to take down the whole Computer Use service.
    ///
    /// On Darwin this is disabled per socket with `SO_NOSIGPIPE`, which is more restrained than a
    /// global `signal(SIGPIPE, SIG_IGN)`: this is library code and has no business changing the
    /// host process's signal disposition. write() returns EPIPE instead, swallowed by writeFrame.
    private func disableSIGPIPE(on fd: Int32) {
        var on: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    }

    private enum AuthOutcome { case authenticated, reject, route }

    /// How a frame is treated under the authentication rules. `operon/authenticate` is **consumed
    /// here in every mode** — never routed, never answered — so even the old path with
    /// authentication disabled silently absorbs the auth frame clients always send first.
    private func authOutcome(for data: Data, authed: Bool) -> AuthOutcome {
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let method = obj?["method"] as? String
        if method == "operon/authenticate" {
            guard let expected = expectedToken else { return .authenticated } // disabled: consume silently
            let token = (obj?["params"] as? [String: Any])?["token"] as? String
            return token == expected ? .authenticated : .reject
        }
        return authed ? .route : .reject
    }

    private func handleConnection(_ client: Int32) {
        // codesign peer verification (off by default; enforced only for signed release builds,
        // see PeerAuth). It layers on top of the token check below.
        guard PeerAuth.authorize(fd: client) else { return }
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 65536)
        // No token configured means let it through (a direct dev or test connection). With one
        // configured, a matching `operon/authenticate` must arrive before the first non-auth
        // frame, or the connection is closed and never routed.
        var authed = (expectedToken == nil)
        readLoop: while true {
            let n = read(client, &chunk, chunk.count)
            if n <= 0 { break }
            buffer.append(contentsOf: chunk[0..<n])
            guard let (messages, remaining) = try? Framing.decode(buffer) else { break }
            buffer = remaining
            for msg in messages {
                switch authOutcome(for: msg, authed: authed) {
                case .authenticated:
                    authed = true
                case .reject:
                    break readLoop
                case .route:
                    if let response = handleMessage(msg) {
                        writeFrame(client, response)
                    }
                }
            }
        }
    }

    private func handleMessage(_ data: Data) -> Data? {
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return nil
        }
        let method = obj["method"] as? String ?? ""
        var response: [String: Any] = ["jsonrpc": "2.0"]
        if let id = obj["id"] { response["id"] = id }

        // **Requests execute back on the main queue**, for two reasons:
        //  1. The AX path reads `NSScreen` (`ComputerUseService` / `AccessibilitySnapshot`), which
        //     is not documented as thread-safe. It has always run on the main thread, and fixing
        //     the connection bug was no reason to change that too.
        //  2. `sync` naturally serialises requests across every connection — AX should not run
        //     concurrently anyway.
        //
        // The main queue is driven by the AppKit event loop at the end of run(), so this cannot
        // deadlock. Downstream of the router we are already on the OS main thread, so main.sync
        // must not be nested.
        let paramsBox = SyncBox(obj["params"])
        let outBox = SyncBox<Result<Any, Error>?>(nil)
        DispatchQueue.main.sync {
            outBox.value = Result {
                if method == "operon/session-ended" {
                    guard let params = paramsBox.value as? [String: Any],
                          let hostSessionID = params["hostSessionID"] as? String,
                          !hostSessionID.isEmpty
                    else {
                        throw ComputerUseControlError(
                            errorDescription: "operon/session-ended requires hostSessionID"
                        )
                    }
                    UserInterruptionMonitor.shared.endHostSession(hostSessionID)
                    router.endBackgroundFocusSessions()
                    return [:]
                }
                return try router.handle(method: method, params: paramsBox.value)
            }
        }
        switch outBox.value {
        case let .success(value):
            response["result"] = value
        case let .failure(error):
            let descriptor = jsonRPCErrorDescriptor(for: error)
            response["error"] = ["code": descriptor.code, "message": descriptor.message]
        case nil:
            response["error"] = ["code": -32603, "message": "internal: router produced no result"]
        }
        return try? JSONSerialization.data(withJSONObject: response)
    }

    /// Writes a whole frame. A peer that has gone away (EPIPE) only means nobody wants this one
    /// response — it is **not a service error**, so give up silently and serve the next
    /// connection. (Paired with `disableSIGPIPE`: without it this code would never be reached,
    /// because the signal would already have killed the process.)
    private func writeFrame(_ client: Int32, _ payload: Data) {
        guard let framed = try? Framing.encode(payload) else { return }
        framed.withUnsafeBytes { raw in
            var off = 0
            let base = raw.baseAddress!
            while off < framed.count {
                let w = write(client, base + off, framed.count - off)
                if w < 0 && errno == EINTR { continue }
                if w <= 0 { break } // EPIPE/EBADF: the peer is gone
                off += w
            }
        }
    }

    private func log(_ message: String) {
        FileHandle.standardError.write(Data("[operon-cu] \(message)\n".utf8))
    }
}
