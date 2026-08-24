import Foundation

/// The requestType values, measured against client.js.
public enum RequestType: String, Codable, Equatable, Sendable {
    case listApps = "ComputerUseIPCListAppsRequest"
    case appPolicy = "ComputerUseIPCAppPolicyRequest"
    case appStart = "ComputerUseIPCAppStartRequest"
    case getSkyshot = "ComputerUseIPCAppGetSkyshotRequest"
    case performAction = "ComputerUseIPCAppPerformActionRequest"
}
