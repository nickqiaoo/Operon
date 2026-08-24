import Foundation
import OpenComputerUseKit

/// Structured list_apps. codex sky's list_apps expects an array of
/// `[{bundleIdentifier?, displayName?, isRunning?, lastUsedDate?, useCount?}]`, which it then
/// `.map`s into ListAppsApp. This shares OpenComputerUseKit's catalog of Spotlight
/// recently-used records rather than returning only the apps currently running.
enum AppList {
    static func catalog() -> [[String: Any]] {
        catalog(from: AppDiscovery.listCatalog())
    }

    static func catalog(from apps: [ListedAppDescriptor]) -> [[String: Any]] {
        apps.map { app in
            var result: [String: Any] = [
                "bundleIdentifier": app.bundleIdentifier,
                "displayName": app.name,
                "isFrontmost": app.isFrontmost,
                "isRunning": app.isRunning,
            ]
            if let lastUsed = app.lastUsed {
                result["lastUsedDate"] = AppDiscovery.usageDateFormatter.string(from: lastUsed)
            }
            if let uses = app.uses {
                result["useCount"] = uses
            }
            return result
        }
    }
}
