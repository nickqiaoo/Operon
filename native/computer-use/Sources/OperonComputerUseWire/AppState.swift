import Foundation

/// The Window(v1) screenshot shape: a data URL and nothing else.
public struct Screenshot: Codable, Equatable, Sendable {
    public var url: String
    public init(url: String) { self.url = url }
}

/// What get_app_state returns: {app, screenshot|null, text}
/// text carries the element_index inline, and defaults to a diff against the previous snapshot —
/// only disableDiff yields the full tree.
public struct AppState: Codable, Equatable, Sendable {
    public var app: String
    public var screenshot: Screenshot?
    public var text: String
    public init(app: String, screenshot: Screenshot?, text: String) {
        self.app = app
        self.screenshot = screenshot
        self.text = text
    }
}

/// One model-facing entry, as sky's JS maps it from the native list_apps result.
public struct ListAppsApp: Codable, Equatable, Sendable {
    public var id: String
    public var displayName: String?
    public var isRunning: Bool?
    public var lastUsedDate: String?
    public var useCount: Int?

    public init(
        id: String,
        displayName: String? = nil,
        isRunning: Bool? = nil,
        lastUsedDate: String? = nil,
        useCount: Int? = nil
    ) {
        self.id = id
        self.displayName = displayName
        self.isRunning = isRunning
        self.lastUsedDate = lastUsedDate
        self.useCount = useCount
    }
}
