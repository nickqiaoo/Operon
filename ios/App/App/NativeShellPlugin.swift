import Foundation
import Capacitor

/// JS ↔ native tab bar bridge, exposed as `NativeShell`.
///
/// The web app keeps owning navigation state; the native bar is a view of it.
///   - `configure({ tabs })` hands over localized titles and returns the space
///     the bar currently takes from the bottom.
///   - `selectTab({ tab })` mirrors a JS-initiated switch (deep link, back).
///   - `setTabBarVisible({ visible })` hides the bar for immersive screens,
///     the keyboard, and full-screen overlays that would otherwise slide in
///     *under* it.
///   - `setTopBar({ mode, title, subtitle, unread })` drives the navigation
///     bar: `context` = project › workspace title + inbox bell, `back` = a
///     lone back button (open conversation), `hidden`.
///   - Events: `tabSelected { tab }` on a tap, `layout { tabBarInset }` when the
///     bar's height changes, `topBarAction { action }` for `context` / `inbox`
///     / `back` taps.
///
/// See `src/lib/native.ts` for the JS side.
@objc(NativeShellPlugin)
public class NativeShellPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeShellPlugin"
    public let jsName = "NativeShell"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selectTab", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTabBarVisible", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTopBar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "presentContextSheet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setAppearance", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "presentAgentSheet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "presentModelSheet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "presentInfoSheet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "presentInboxSheet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateInboxSheet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dismissInboxSheet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "promptText", returnType: CAPPluginReturnPromise),
    ]

    /// The live inbox sheet, while one is up.
    private var inboxModel: InboxSheetModel?
    private var inboxDismisser: SheetDismisser?

    private var presenter: UIViewController? { bridge?.viewController?.parent }

    private var shell: ShellChromeController? {
        (bridge?.viewController?.parent as? ShellRootController)?.chrome
    }

    private func onMain(_ call: CAPPluginCall, _ body: @escaping (ShellChromeController) -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let shell = self?.shell else {
                call.reject("Native shell is not the root view controller")
                return
            }
            body(shell)
        }
    }

    @objc func configure(_ call: CAPPluginCall) {
        let tabs = call.getArray("tabs", JSObject.self) ?? []
        var titles: [String: String] = [:]
        for tab in tabs {
            if let id = tab["id"] as? String, let title = tab["title"] as? String {
                titles[id] = title
            }
        }
        onMain(call) { [weak self] shell in
            shell.setTitles(titles)
            shell.onTabSelected = { id in
                self?.notifyListeners("tabSelected", data: ["tab": id])
            }
            shell.onTabBarInsetChanged = { inset in
                self?.notifyListeners("layout", data: ["tabBarInset": inset])
            }
            shell.onTopBarAction = { action in
                self?.notifyListeners("topBarAction", data: ["action": action])
            }
            call.resolve(["tabBarInset": shell.tabBarInset])
        }
    }

    @objc func selectTab(_ call: CAPPluginCall) {
        guard let tab = call.getString("tab") else {
            call.reject("tab is required")
            return
        }
        onMain(call) { shell in
            shell.select(tabId: tab)
            call.resolve()
        }
    }

    @objc func setTopBar(_ call: CAPPluginCall) {
        guard let mode = ShellChromeController.TopBarMode(rawValue: call.getString("mode") ?? "") else {
            call.reject("mode must be hidden | context | back")
            return
        }
        let title = call.getString("title") ?? "operon"
        let subtitle = call.getString("subtitle")
        let unread = call.getBool("unread") ?? false
        let interactive = call.getBool("interactive") ?? true
        onMain(call) { shell in
            shell.setTopBar(mode: mode, title: title, subtitle: subtitle, unread: unread, interactive: interactive)
            call.resolve()
        }
    }

    /// "New chat" agent picker as a system sheet; the pick arrives as
    /// `agentPicked { id }`.
    @objc func presentAgentSheet(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? "New chat"
        let emptyText = call.getString("emptyText") ?? "Loading agents…"
        let agents: [AgentSheetAgent] = (call.getArray("agents", JSObject.self) ?? []).compactMap { raw in
            guard let id = raw["id"] as? String, let label = raw["label"] as? String else { return nil }
            return AgentSheetAgent(id: id, label: label, logo: raw["logo"] as? String)
        }
        DispatchQueue.main.async { [weak self] in
            guard let presenter = self?.bridge?.viewController?.parent else {
                call.reject("Native shell is not the root view controller")
                return
            }
            AgentSheetView.present(
                from: presenter,
                title: title,
                emptyText: emptyText,
                agents: agents,
                onPick: { id in self?.notifyListeners("agentPicked", data: ["id": id]) },
                onDismiss: {}
            )
            call.resolve()
        }
    }

    /// Model picker; the pick arrives as `modelPicked { id }`.
    @objc func presentModelSheet(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? "Select model"
        let searchPlaceholder = call.getString("searchPlaceholder") ?? "Search models..."
        let emptyText = call.getString("emptyText") ?? "No models found."
        let selectedId = call.getString("selectedId")
        let models: [ModelSheetModel] = (call.getArray("models", JSObject.self) ?? []).compactMap { raw in
            guard let id = raw["id"] as? String, let label = raw["label"] as? String else { return nil }
            return ModelSheetModel(id: id, label: label, group: raw["group"] as? String ?? "", logo: raw["logo"] as? String)
        }
        DispatchQueue.main.async { [weak self] in
            guard let presenter = self?.presenter else {
                call.reject("Native shell is not the root view controller")
                return
            }
            ModelSheetView.present(
                from: presenter, title: title, searchPlaceholder: searchPlaceholder, emptyText: emptyText,
                models: models, selectedId: selectedId,
                onPick: { id in self?.notifyListeners("modelPicked", data: ["id": id]) },
                onDismiss: {}
            )
            call.resolve()
        }
    }

    /// Read-only stats (context window, subscription quotas).
    @objc func presentInfoSheet(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? ""
        let caption = call.getString("caption")
        let sections: [InfoSheetSection] = (call.getArray("sections", JSObject.self) ?? []).map { raw in
            let rows: [InfoSheetSection.Row] = ((raw["rows"] as? JSArray) ?? []).compactMap { entry in
                guard let r = entry as? JSObject, let label = r["label"] as? String else { return nil }
                return .init(label: label, value: r["value"] as? String, detail: r["detail"] as? String,
                             color: r["color"] as? String, indent: r["indent"] as? Bool ?? false)
            }
            return InfoSheetSection(
                header: raw["header"] as? String,
                value: raw["value"] as? String,
                progress: raw["progress"] as? Double,
                tone: InfoSheetSection.Tone(rawValue: raw["tone"] as? String ?? "") ?? .normal,
                footer: raw["footer"] as? String,
                rows: rows
            )
        }
        DispatchQueue.main.async { [weak self] in
            guard let presenter = self?.presenter else {
                call.reject("Native shell is not the root view controller")
                return
            }
            InfoSheetView.present(from: presenter, title: title, caption: caption, sections: sections, onDismiss: {})
            call.resolve()
        }
    }

    private func inboxState(from obj: JSObject?) -> InboxSheetState {
        let items: [InboxSheetItem] = ((obj?["items"] as? JSArray) ?? []).compactMap { entry in
            guard let r = entry as? JSObject, let id = r["id"] as? Int, let title = r["title"] as? String else { return nil }
            return InboxSheetItem(
                id: id, title: title, body: r["body"] as? String, time: r["time"] as? String ?? "",
                symbol: r["symbol"] as? String ?? "message", action: r["action"] as? Bool ?? false,
                unread: r["unread"] as? Bool ?? false
            )
        }
        return InboxSheetState(
            filter: obj?["filter"] as? String ?? "all", items: items,
            loading: obj?["loading"] as? Bool ?? false, loadingMore: obj?["loadingMore"] as? Bool ?? false,
            hasMore: obj?["hasMore"] as? Bool ?? false, unreadCount: obj?["unreadCount"] as? Int ?? 0
        )
    }

    /// Live inbox. Controls come back as `inboxAction { action, id?, filter? }`,
    /// JS keeps it current with `updateInboxSheet`; `inboxSheetDismissed` ends it.
    @objc func presentInboxSheet(_ call: CAPPluginCall) {
        let labelsObj = call.getObject("labels") ?? [:]
        let filters: [(id: String, label: String)] = ((labelsObj["filters"] as? JSArray) ?? []).compactMap { entry in
            guard let f = entry as? JSObject, let id = f["id"] as? String, let label = f["label"] as? String else { return nil }
            return (id: id, label: label)
        }
        let labels = InboxSheetLabels(
            title: labelsObj["title"] as? String ?? "Inbox",
            filters: filters,
            markAllRead: labelsObj["markAllRead"] as? String ?? "Mark all read",
            empty: labelsObj["empty"] as? String ?? "You're all caught up",
            loading: labelsObj["loading"] as? String ?? "Loading…",
            loadMore: labelsObj["loadMore"] as? String ?? "Load more"
        )
        let state = inboxState(from: call.getObject("state"))
        DispatchQueue.main.async { [weak self] in
            guard let self, let presenter = self.presenter else {
                call.reject("Native shell is not the root view controller")
                return
            }
            let (model, dismisser) = InboxSheetView.present(
                from: presenter, labels: labels, state: state,
                onAction: { [weak self] action, arg in
                    var data: [String: Any] = ["action": action]
                    if let arg {
                        if action == "filter" { data["filter"] = arg } else if let id = Int(arg) { data["id"] = id }
                    }
                    self?.notifyListeners("inboxAction", data: data)
                },
                onDismiss: { [weak self] in
                    self?.inboxModel = nil
                    self?.inboxDismisser = nil
                    self?.notifyListeners("inboxSheetDismissed", data: [:])
                }
            )
            self.inboxModel = model
            self.inboxDismisser = dismisser
            call.resolve()
        }
    }

    @objc func updateInboxSheet(_ call: CAPPluginCall) {
        let state = inboxState(from: call.getObject("state"))
        DispatchQueue.main.async { [weak self] in
            self?.inboxModel?.state = state
            call.resolve()
        }
    }

    @objc func dismissInboxSheet(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.inboxDismisser?.dismiss()
            call.resolve()
        }
    }

    /// System alert with one text field. Resolves `{ value }`, or `{ value: null }` on cancel.
    @objc func promptText(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? ""
        let message = call.getString("message")
        let placeholder = call.getString("placeholder") ?? ""
        let confirmLabel = call.getString("confirmLabel") ?? "OK"
        let cancelLabel = call.getString("cancelLabel") ?? "Cancel"
        DispatchQueue.main.async { [weak self] in
            guard let presenter = self?.presenter else {
                call.reject("Native shell is not the root view controller")
                return
            }
            let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
            alert.addTextField { field in
                field.placeholder = placeholder
                field.autocapitalizationType = .none
                field.autocorrectionType = .no
            }
            alert.addAction(UIAlertAction(title: cancelLabel, style: .cancel) { _ in
                call.resolve(["value": NSNull()])
            })
            alert.addAction(UIAlertAction(title: confirmLabel, style: .default) { _ in
                let value = alert.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                call.resolve(["value": value.isEmpty ? NSNull() : value])
            })
            presenter.present(alert, animated: true)
        }
    }

    /// Light / dark for every native surface, following the app's own theme
    /// rather than the OS.
    @objc func setAppearance(_ call: CAPPluginCall) {
        let dark = call.getBool("dark") ?? false
        DispatchQueue.main.async { [weak self] in
            guard let root = self?.bridge?.viewController?.parent as? ShellRootController else {
                call.reject("Native shell is not the root view controller")
                return
            }
            root.setAppearance(dark: dark)
            call.resolve()
        }
    }

    /// Project → workspace picker as a system sheet. Resolves when the sheet
    /// is up; the pick arrives as `contextPicked { projectId, workspaceId? }`
    /// and every dismissal (pick or swipe) as `contextSheetDismissed`.
    @objc func presentContextSheet(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? "Switch project"
        let emptyText = call.getString("emptyText") ?? "No projects yet."
        let activeProjectId = call.getInt("activeProjectId")
        let activeWorkspaceId = call.getInt("activeWorkspaceId")
        let projects: [ContextSheetProject] = (call.getArray("projects", JSObject.self) ?? []).compactMap { raw in
            guard let id = raw["id"] as? Int, let name = raw["name"] as? String else { return nil }
            let workspaces: [ContextSheetProject.Workspace] = ((raw["workspaces"] as? JSArray) ?? []).compactMap { entry in
                guard let ws = entry as? JSObject, let wid = ws["id"] as? Int, let wname = ws["name"] as? String else { return nil }
                return .init(id: wid, name: wname)
            }
            return ContextSheetProject(id: id, name: name, workspaces: workspaces)
        }
        DispatchQueue.main.async { [weak self] in
            guard let presenter = self?.bridge?.viewController?.parent else {
                call.reject("Native shell is not the root view controller")
                return
            }
            ContextSheetView.present(
                from: presenter,
                title: title,
                emptyText: emptyText,
                projects: projects,
                activeProjectId: activeProjectId,
                activeWorkspaceId: activeWorkspaceId,
                onPick: { projectId, workspaceId in
                    var data: [String: Any] = ["projectId": projectId]
                    if let workspaceId { data["workspaceId"] = workspaceId }
                    self?.notifyListeners("contextPicked", data: data)
                },
                onDismiss: {
                    self?.notifyListeners("contextSheetDismissed", data: [:])
                }
            )
            call.resolve()
        }
    }

    @objc func setTabBarVisible(_ call: CAPPluginCall) {
        let visible = call.getBool("visible") ?? true
        onMain(call) { shell in
            shell.setTabBarHidden(!visible)
            call.resolve()
        }
    }
}
