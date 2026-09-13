package com.operon.app.shell

import android.text.InputType
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import com.operon.app.R
import org.json.JSONArray
import org.json.JSONObject

/**
 * JS ↔ native shell bridge, exposed as `NativeShell`.
 *
 * The Android half of ios/App/App/NativeShellPlugin.swift, and deliberately
 * the same plugin under the same name with the same methods and events — the
 * contract in src/lib/native.ts was already platform-neutral, so the web app
 * needs no Android branch. Method by method:
 *
 *   - `configure({ tabs })` hands over localized titles and returns the space
 *     the bar currently takes from the bottom.
 *   - `selectTab({ tab })` mirrors a JS-initiated switch (deep link, back).
 *   - `setTabBarVisible({ visible })` hides the bar for immersive screens, the
 *     keyboard, and full-screen web overlays.
 *   - `setTopBar({ mode, title, subtitle, unread, interactive })` drives the
 *     top app bar: `context` = project › workspace title + inbox bell,
 *     `back` = a lone back button, `hidden`.
 *   - The five `present*Sheet` methods put a Material modal bottom sheet up
 *     over the web view; picks come back as events.
 *   - Events: `tabSelected`, `layout`, `topBarAction`, `contextPicked`,
 *     `contextSheetDismissed`, `agentPicked`, `modelPicked`, `inboxAction`,
 *     `inboxSheetDismissed`.
 */
@CapacitorPlugin(name = "NativeShell")
class NativeShellPlugin : Plugin() {

    private val shellActivity: AppCompatActivity?
        get() = activity as? AppCompatActivity

    private var chromeRef: ShellChrome? = null

    /** Light / dark for the sheets, mirroring what the chrome was last told. */
    private var dark = false

    /** The live inbox sheet, while one is up. */
    private var inbox: InboxSheet.Controller? = null

    /** Sheets that are not the inbox, kept only so a second present replaces the first. */
    private var openSheet: BottomSheetDialog? = null

    private fun chrome(): ShellChrome? {
        chromeRef?.let { return it }
        val activity = shellActivity ?: return null
        val created = ShellChrome(activity)
        created.attach()
        chromeRef = created
        return created
    }

    /**
     * Every native view has to be built on the UI thread, and every one of
     * these methods either builds one or asks one to change.
     */
    private fun onMain(call: PluginCall, body: (ShellChrome) -> Unit) {
        val activity = shellActivity
        if (activity == null) {
            call.reject("Native shell is not available")
            return
        }
        activity.runOnUiThread {
            val chrome = chrome()
            if (chrome == null) {
                call.reject("Native shell is not available")
            } else {
                body(chrome)
            }
        }
    }

    private fun onMainSheet(call: PluginCall, body: (AppCompatActivity) -> Unit) {
        val activity = shellActivity
        if (activity == null) {
            call.reject("Native shell is not available")
            return
        }
        activity.runOnUiThread { body(activity) }
    }

    // MARK: - Bars

    @PluginMethod
    fun configure(call: PluginCall) {
        val titles = mutableMapOf<String, String>()
        call.getArray("tabs", JSArray())?.let { tabs ->
            for (index in 0 until tabs.length()) {
                val tab = tabs.optJSONObject(index) ?: continue
                val id = tab.optString("id").takeIf { it.isNotEmpty() } ?: continue
                val title = tab.optString("title").takeIf { it.isNotEmpty() } ?: continue
                titles[id] = title
            }
        }
        onMain(call) { chrome ->
            chrome.setTitles(titles)
            chrome.onTabSelected = { id -> notifyListeners("tabSelected", JSObject().put("tab", id)) }
            chrome.onTabBarInsetChanged = { inset ->
                notifyListeners("layout", JSObject().put("tabBarInset", inset))
            }
            chrome.onTopBarAction = { action ->
                notifyListeners("topBarAction", JSObject().put("action", action))
            }
            call.resolve(JSObject().put("tabBarInset", chrome.tabBarInset))
        }
    }

    @PluginMethod
    fun selectTab(call: PluginCall) {
        val tab = call.getString("tab")
        if (tab == null) {
            call.reject("tab is required")
            return
        }
        onMain(call) { chrome ->
            chrome.select(tab)
            call.resolve()
        }
    }

    @PluginMethod
    fun setTabBarVisible(call: PluginCall) {
        val visible = call.getBoolean("visible", true) ?: true
        onMain(call) { chrome ->
            chrome.setTabBarHidden(!visible)
            call.resolve()
        }
    }

    @PluginMethod
    fun setTopBar(call: PluginCall) {
        val mode = ShellChrome.TopBarMode.from(call.getString("mode").orEmpty())
        if (mode == null) {
            call.reject("mode must be hidden | context | back")
            return
        }
        val title = call.getString("title") ?: "operon"
        val subtitle = call.getString("subtitle")
        val unread = call.getBoolean("unread", false) ?: false
        val interactive = call.getBoolean("interactive", true) ?: true
        onMain(call) { chrome ->
            chrome.setTopBar(mode, title, subtitle, unread, interactive)
            call.resolve()
        }
    }

    /**
     * Light / dark for every native surface, following the app's own theme
     * rather than the OS.
     */
    @PluginMethod
    fun setAppearance(call: PluginCall) {
        val dark = call.getBoolean("dark", false) ?: false
        this.dark = dark
        onMain(call) { chrome ->
            chrome.setAppearance(dark)
            call.resolve()
        }
    }

    // MARK: - Sheets

    @PluginMethod
    fun presentContextSheet(call: PluginCall) {
        val title = call.getString("title") ?: "Switch project"
        val emptyText = call.getString("emptyText") ?: "No projects yet."
        val activeProjectId = call.getInt("activeProjectId")
        val activeWorkspaceId = call.getInt("activeWorkspaceId")
        val projects = call.getArray("projects", JSArray())?.objects().orEmpty().mapNotNull { raw ->
            val id = raw.optIntOrNull("id") ?: return@mapNotNull null
            val name = raw.optString("name").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            val workspaces = raw.optJSONArray("workspaces").objects().mapNotNull { ws ->
                val wid = ws.optIntOrNull("id") ?: return@mapNotNull null
                val wname = ws.optString("name").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                ContextSheet.Workspace(wid, wname)
            }
            ContextSheet.Project(id, name, workspaces)
        }

        onMainSheet(call) { activity ->
            openSheet?.dismiss()
            openSheet = ContextSheet.present(
                context = SheetUi.themed(activity, dark),
                title = title,
                emptyText = emptyText,
                projects = projects,
                activeProjectId = activeProjectId,
                activeWorkspaceId = activeWorkspaceId,
                onPick = { projectId, workspaceId ->
                    val data = JSObject().put("projectId", projectId)
                    if (workspaceId != null) data.put("workspaceId", workspaceId)
                    notifyListeners("contextPicked", data)
                },
                onDismiss = {
                    openSheet = null
                    notifyListeners("contextSheetDismissed", JSObject())
                },
            )
            call.resolve()
        }
    }

    @PluginMethod
    fun presentAgentSheet(call: PluginCall) {
        val title = call.getString("title") ?: "New chat"
        val emptyText = call.getString("emptyText") ?: "Loading agents…"
        val agents = call.getArray("agents", JSArray())?.objects().orEmpty().mapNotNull { raw ->
            val id = raw.optString("id").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            val label = raw.optString("label").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            AgentSheet.Agent(id, label, raw.optStringOrNull("logo"))
        }

        onMainSheet(call) { activity ->
            openSheet?.dismiss()
            openSheet = AgentSheet.present(
                context = SheetUi.themed(activity, dark),
                title = title,
                emptyText = emptyText,
                agents = agents,
                onPick = { id -> notifyListeners("agentPicked", JSObject().put("id", id)) },
                onDismiss = { openSheet = null },
            )
            call.resolve()
        }
    }

    @PluginMethod
    fun presentModelSheet(call: PluginCall) {
        val title = call.getString("title") ?: "Select model"
        val searchPlaceholder = call.getString("searchPlaceholder") ?: "Search models..."
        val emptyText = call.getString("emptyText") ?: "No models found."
        val selectedId = call.getString("selectedId")
        val models = call.getArray("models", JSArray())?.objects().orEmpty().mapNotNull { raw ->
            val id = raw.optString("id").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            val label = raw.optString("label").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            ModelSheet.Model(id, label, raw.optString("group"), raw.optStringOrNull("logo"))
        }

        onMainSheet(call) { activity ->
            openSheet?.dismiss()
            openSheet = ModelSheet.present(
                context = SheetUi.themed(activity, dark),
                title = title,
                searchPlaceholder = searchPlaceholder,
                emptyText = emptyText,
                models = models,
                selectedId = selectedId,
                onPick = { id -> notifyListeners("modelPicked", JSObject().put("id", id)) },
                onDismiss = { openSheet = null },
            )
            call.resolve()
        }
    }

    @PluginMethod
    fun presentInfoSheet(call: PluginCall) {
        val title = call.getString("title") ?: ""
        val caption = call.getString("caption")
        val sections = call.getArray("sections", JSArray())?.objects().orEmpty().map { raw ->
            val rows = raw.optJSONArray("rows").objects().mapNotNull { entry ->
                val label = entry.optString("label").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                InfoSheet.Row(
                    label = label,
                    value = entry.optStringOrNull("value"),
                    detail = entry.optStringOrNull("detail"),
                    color = entry.optStringOrNull("color"),
                    indent = entry.optBoolean("indent", false),
                )
            }
            InfoSheet.Section(
                header = raw.optStringOrNull("header"),
                value = raw.optStringOrNull("value"),
                progress = if (raw.has("progress") && !raw.isNull("progress")) raw.optDouble("progress") else null,
                tone = InfoSheet.Tone.from(raw.optStringOrNull("tone")),
                footer = raw.optStringOrNull("footer"),
                rows = rows,
            )
        }

        onMainSheet(call) { activity ->
            openSheet?.dismiss()
            openSheet = InfoSheet.present(
                context = SheetUi.themed(activity, dark),
                title = title,
                caption = caption,
                sections = sections,
                onDismiss = { openSheet = null },
            )
            call.resolve()
        }
    }

    // MARK: - Inbox

    private fun inboxState(obj: JSObject?): InboxSheet.State {
        val items = obj?.optJSONArray("items").objects().mapNotNull { raw ->
            val id = raw.optIntOrNull("id") ?: return@mapNotNull null
            val title = raw.optString("title").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            InboxSheet.Item(
                id = id,
                title = title,
                body = raw.optStringOrNull("body"),
                time = raw.optString("time"),
                symbol = raw.optString("symbol").takeIf { it.isNotEmpty() } ?: "message",
                action = raw.optBoolean("action", false),
                unread = raw.optBoolean("unread", false),
            )
        }
        return InboxSheet.State(
            filter = obj?.optString("filter").takeIf { !it.isNullOrEmpty() } ?: "all",
            items = items,
            loading = obj?.optBoolean("loading", false) ?: false,
            loadingMore = obj?.optBoolean("loadingMore", false) ?: false,
            hasMore = obj?.optBoolean("hasMore", false) ?: false,
            unreadCount = obj?.optInt("unreadCount", 0) ?: 0,
        )
    }

    @PluginMethod
    fun presentInboxSheet(call: PluginCall) {
        val labelsObj = call.getObject("labels") ?: JSObject()
        val filters = labelsObj.optJSONArray("filters").objects().mapNotNull { raw ->
            val id = raw.optString("id").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            val label = raw.optString("label").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            id to label
        }
        val labels = InboxSheet.Labels(
            title = labelsObj.optStringOrNull("title") ?: "Inbox",
            filters = filters,
            markAllRead = labelsObj.optStringOrNull("markAllRead") ?: "Mark all read",
            empty = labelsObj.optStringOrNull("empty") ?: "You're all caught up",
            loading = labelsObj.optStringOrNull("loading") ?: "Loading…",
            loadMore = labelsObj.optStringOrNull("loadMore") ?: "Load more",
        )
        val state = inboxState(call.getObject("state"))

        onMainSheet(call) { activity ->
            openSheet?.dismiss()
            inbox?.dismiss()
            val controller = InboxSheet.Controller(
                context = SheetUi.themed(activity, dark),
                labels = labels,
                onAction = { action, argument ->
                    val data = JSObject().put("action", action)
                    if (argument != null) {
                        if (action == "filter") {
                            data.put("filter", argument)
                        } else {
                            argument.toIntOrNull()?.let { data.put("id", it) }
                        }
                    }
                    notifyListeners("inboxAction", data)
                },
            )
            controller.present(state) {
                inbox = null
                notifyListeners("inboxSheetDismissed", JSObject())
            }
            inbox = controller
            call.resolve()
        }
    }

    @PluginMethod
    fun updateInboxSheet(call: PluginCall) {
        val state = inboxState(call.getObject("state"))
        onMainSheet(call) {
            inbox?.update(state)
            call.resolve()
        }
    }

    @PluginMethod
    fun dismissInboxSheet(call: PluginCall) {
        onMainSheet(call) {
            inbox?.dismiss()
            inbox = null
            call.resolve()
        }
    }

    // MARK: - Prompt

    /**
     * System alert with one text field. Resolves `{ value }`, or
     * `{ value: null }` on cancel or empty input.
     */
    @PluginMethod
    fun promptText(call: PluginCall) {
        val title = call.getString("title") ?: ""
        val message = call.getString("message")
        val placeholder = call.getString("placeholder") ?: ""
        val confirmLabel = call.getString("confirmLabel") ?: "OK"
        val cancelLabel = call.getString("cancelLabel") ?: "Cancel"

        onMainSheet(call) { activity ->
            val themed = SheetUi.themed(activity, dark, sheet = false)
            val field = TextInputEditText(themed).apply {
                hint = placeholder
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                setSingleLine()
            }
            val wrapper = TextInputLayout(themed).apply {
                val pad = resources.getDimensionPixelSize(
                    com.google.android.material.R.dimen.abc_dialog_padding_material,
                )
                setPadding(pad, pad / 2, pad, 0)
                addView(field, FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                ))
            }

            var answered = false
            fun answer(value: String?) {
                if (answered) return
                answered = true
                val result = JSObject()
                if (value.isNullOrEmpty()) result.put("value", JSONObject.NULL) else result.put("value", value)
                call.resolve(result)
            }

            MaterialAlertDialogBuilder(themed)
                .setTitle(title)
                .apply { if (!message.isNullOrEmpty()) setMessage(message) }
                .setView(wrapper)
                .setNegativeButton(cancelLabel) { _, _ -> answer(null) }
                .setPositiveButton(confirmLabel) { _, _ -> answer(field.text?.toString()?.trim()) }
                // Tapping outside or pressing back is a cancel, not a dropped
                // promise: the JS caller is awaiting this either way.
                .setOnDismissListener { answer(null) }
                .show()
        }
    }
}

// ---- JSON helpers ----
//
// Capacitor hands plugin arguments over as org.json values, whose accessors
// answer "" and 0 for a missing key. These make "absent" distinguishable from
// "empty", which several of the fields above genuinely need.

private typealias JSArray = com.getcapacitor.JSArray

private fun JSONArray?.objects(): List<JSONObject> {
    if (this == null) return emptyList()
    return (0 until length()).mapNotNull { optJSONObject(it) }
}

private fun JSArray?.objects(): List<JSONObject> = (this as JSONArray?).objects()

private fun JSONObject.optStringOrNull(key: String): String? =
    if (isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }

private fun JSONObject.optIntOrNull(key: String): Int? = if (has(key) && !isNull(key)) optInt(key) else null
