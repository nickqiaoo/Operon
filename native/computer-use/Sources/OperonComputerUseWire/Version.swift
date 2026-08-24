import Foundation

/// The wire protocol version, returned during the `ping` handshake. sky's `clientApiVersion` must
/// match or the connection is refused. This value was measured against codex (@oai/sky v0.4.20,
/// the default apiVersion in client.js).
public enum WireVersion {
    public static let current = "CodexComputerUseIPC-2"
}

/// codex's default socket path. operon uses its own App Group; the env var
/// `SKY_CUA_NATIVE_PIPE_PATH` overrides it.
public enum WirePaths {
    public static let codexDefaultSocketSuffix =
        "Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock"
    public static let socketPathEnvKey = "SKY_CUA_NATIVE_PIPE_PATH"
}
