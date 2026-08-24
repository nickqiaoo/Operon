import Foundation
import OpenComputerUseKit

/// Maps the open engine's `ToolCallResult` (an MCP content array) onto codex's response shape.
public enum ResponseMapping {

    /// get_app_state：content[] → codex **IPC** MacWindowAppState
    /// `{ app, skyshot: { text, screenshot?: { url } } }`
    ///
    /// Note this is the wire shape on the socket. sky's JS `window_result` flattens it further
    /// into the model-facing `{ app, screenshot, text }`. Without `skyshot`, that JS rejects the
    /// state as invalid.
    public static func appStateJSON(
        from result: ToolCallResult,
        app: String,
        screenshotDirectory: URL? = nil
    ) throws -> [String: Any] {
        let content = (result.asDictionary["content"] as? [[String: Any]]) ?? []
        var text = ""
        var screenshot: [String: Any]? = nil
        for item in content {
            switch item["type"] as? String {
            case "text":
                if let t = item["text"] as? String { text = t }
            case "image":
                if let data = item["data"] as? String {
                    let mime = item["mimeType"] as? String ?? "image/png"
                    screenshot = try screenshotJSON(
                        base64: data,
                        mimeType: mime,
                        directory: screenshotDirectory
                    )
                }
            default:
                break
            }
        }
        var skyshot: [String: Any] = ["text": text]
        if let screenshot {
            skyshot["screenshot"] = screenshot
        }
        return ["app": app, "skyshot": skyshot]
    }

    /// Codex exposes screenshots as short `file://` references. Keep base64 on the
    /// engine side only; the model-facing wire should never carry the image bytes.
    private static func screenshotJSON(
        base64: String,
        mimeType: String,
        directory: URL?
    ) throws -> [String: Any] {
        guard let bytes = Data(base64Encoded: base64) else {
            throw MappingError.invalid("screenshot data is not valid base64")
        }

        let outputDirectory = directory ?? FileManager.default.temporaryDirectory
            .appendingPathComponent("operon-computer-use-shots", isDirectory: true)
        try FileManager.default.createDirectory(
            at: outputDirectory,
            withIntermediateDirectories: true
        )

        let lowercasedMimeType = mimeType.lowercased()
        let fileExtension: String
        if lowercasedMimeType.contains("jpeg") || lowercasedMimeType.contains("jpg") {
            fileExtension = "jpg"
        } else if lowercasedMimeType.contains("webp") {
            fileExtension = "webp"
        } else {
            fileExtension = "png"
        }

        let fileURL = outputDirectory
            .appendingPathComponent("shot-\(UUID().uuidString)")
            .appendingPathExtension(fileExtension)
        try bytes.write(to: fileURL, options: .atomic)
        return ["url": fileURL.absoluteString]
    }

    /// getAppPolicy: returns the canonical bundle id, display name, path and security decision as
    /// resolved by the native layer.
    public static func appPolicyJSON(from policy: ComputerUseAppPolicyTarget) -> [String: Any] {
        var target: [String: Any] = [
            "bundleIdentifier": policy.bundleIdentifier,
            "displayName": policy.displayName,
            "appPath": policy.appPath,
            "risk": policy.risk.rawValue,
        ]
        if let warningSubtitle = policy.warningSubtitle {
            target["warningSubtitle"] = warningSubtitle
        }
        return [
            "decision": policy.decision.rawValue,
            "target": [
                "bundleIdentifier": target["bundleIdentifier"]!,
                "displayName": target["displayName"]!,
                "appPath": target["appPath"]!,
                "risk": target["risk"]!,
                "warningSubtitle": target["warningSubtitle"] ?? NSNull(),
            ],
            "allowPersistentApproval": policy.allowPersistentApproval,
        ]
    }
}
