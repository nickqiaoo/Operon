import ApplicationServices
import Foundation
import OperonComputerUseWire
import OpenComputerUseKit

/// JSON-RPC routing for `ping` and `request`: dispatches codex's requestType to the open engine.
public final class WireRouter {
    private let dispatcher: ComputerUseToolDispatcher

    public init(dispatcher: ComputerUseToolDispatcher = ComputerUseToolDispatcher()) {
        self.dispatcher = dispatcher
    }

    /// Host session ended — release synthetic focus on every target app.
    public func endBackgroundFocusSessions() {
        dispatcher.endBackgroundFocusSessions()
    }

    /// Returns a result (Any) that JSONSerialization can encode; anything thrown is turned into a
    /// JSON-RPC error by the socket layer.
    public func handle(method: String, params: Any?) throws -> Any {
        switch method {
        case "ping":
            // clientApiVersion could be validated here; we always answer with our own version.
            return ["serverApiVersion": WireVersion.current]
        case "request":
            return try handleRequest(params: params)
        case "operon/permissions":
            // Host-facing only. Both grants belong to *this* process (TCC follows
            // the running binary), so the engine is the only honest reporter.
            //
            // Deliberately runtime checks rather than `PermissionDiagnostics`:
            // that one also ORs in TCC rows for the upstream OpenComputerUse app
            // bundle, which would report a grant this binary does not have.
            // `ScreenRecordingAccess` is the same authority the capture path uses,
            // so Settings and the actual screenshot can never disagree.
            return [
                "accessibility": AXIsProcessTrusted(),
                "screenRecording": ScreenRecordingAccess.isGranted,
            ]
        case "operon/open-permission-settings":
            guard let params = params as? [String: Any],
                  let raw = params["permission"] as? String,
                  let permission = SystemPermissionKind(rawValue: raw)
            else {
                throw MappingError.invalid(
                    "operon/open-permission-settings requires permission=accessibility|screenRecording"
                )
            }
            PermissionSupport.openSystemSettings(for: permission)
            return [:]
        default:
            throw MappingError.unsupported("unknown method: \(method)")
        }
    }

    private func handleRequest(params: Any?) throws -> Any {
        guard let p = params as? [String: Any],
              let raw = p["requestType"] as? String,
              let requestType = RequestType(rawValue: raw)
        else {
            throw MappingError.invalid("request has no valid requestType")
        }
        let request = p["request"]
        let turnMetadata = p["codexTurnMetadata"]

        switch requestType {
        case .performAction:
            let reqData = try JSONSerialization.data(withJSONObject: request ?? [:])
            let par = try JSONDecoder().decode(PerformActionRequest.self, from: reqData)
            try UserInterruptionMonitor.shared.beginRequest(
                app: par.app,
                metadata: turnMetadata,
                kind: .performAction
            )
            // Codex: no FocusStealGuard. Background focus is synthetic postToPid
            // only — the system front process never moves, so there is nothing
            // to restore.
            let (name, args) = try ActionMapping.dispatcherCall(
                app: par.app,
                action: par.action
            )
            let result = try dispatcher.callTool(name: name, arguments: args)
            // Model settle and host PiP are deliberately separate. The model
            // receives skyshots; the remote CAContext updates continuously.
            dispatcher.waitForUIToSettle(app: par.app)
            _ = result
            return NSNull()

        case .getSkyshot:
            let req = request as? [String: Any]
            let app = req?["app"] as? String ?? ""
            let disableDiff = req?["disableDiff"] as? Bool ?? false
            try UserInterruptionMonitor.shared.beginRequest(
                app: app,
                metadata: turnMetadata,
                kind: .readState
            )
            // Read path: zero activation (Codex get_app_state).
            let result = try dispatcher.callTool(
                name: "get_app_state",
                arguments: ["app": app, "disable_diff": disableDiff],
            )
            return try ResponseMapping.appStateJSON(from: result, app: app)

        case .listApps:
            return AppList.catalog()

        case .appPolicy:
            let app = (request as? [String: Any])?["app"] as? String ?? ""
            let policy = try ComputerUseAppPolicyResolver.resolve(app)
            return ResponseMapping.appPolicyJSON(from: policy)

        case .appStart:
            // A no-op in v1: the engine has no start tool (§11.7 TODO)
            return NSNull()
        }
    }

}
