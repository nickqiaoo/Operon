package com.operon.app.shell

import android.content.Context
import android.graphics.drawable.Drawable
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.view.ContextThemeWrapper
import androidx.core.graphics.drawable.DrawableCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updateLayoutParams
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.button.MaterialButton
import com.operon.app.R

/**
 * The native tab bar and top app bar, drawn over Capacitor's web view.
 *
 * The Android half of ios/App/App/ShellTabBarController.swift, and it keeps
 * that side's division of labour: the web app still owns navigation, and these
 * bars are a view of its state, mirrored over [NativeShellPlugin].
 *
 * Two things differ from iOS, both because the platforms differ rather than by
 * preference:
 *
 *  - The top bar takes real space instead of floating. iOS folds the
 *    navigation bar's height into `additionalSafeAreaInsets`, so
 *    `env(safe-area-inset-top)` grows and the page moves down on its own. An
 *    Android web view has no such hook — `env(safe-area-inset-top)` reports
 *    the display cutout and nothing else — so the shell moves the web view
 *    down by setting a top margin, which is also how a Material top app bar
 *    normally behaves. The status bar is always left clear for the same
 *    reason: nothing else would make the page avoid it.
 *  - The tab bar does float, and reports the space it covers over the
 *    `layout` event, exactly as on iOS. The web shell pads its own content by
 *    that number.
 */
class ShellChrome(private val activity: AppCompatActivity) {

    /** Order must match `MOBILE_TABS` on the JS side. */
    private val tabIds = listOf("chats", "channel", "changes", "more")
    private val tabMenuIds = listOf(
        R.id.operon_tab_chats,
        R.id.operon_tab_channel,
        R.id.operon_tab_changes,
        R.id.operon_tab_more,
    )

    enum class TopBarMode { HIDDEN, CONTEXT, BACK;
        companion object {
            fun from(raw: String): TopBarMode? = when (raw) {
                "hidden" -> HIDDEN
                "context" -> CONTEXT
                "back" -> BACK
                else -> null
            }
        }
    }

    var onTabSelected: ((String) -> Unit)? = null
    var onTabBarInsetChanged: ((Double) -> Unit)? = null
    var onTopBarAction: ((String) -> Unit)? = null

    /** Space the tab bar takes from the bottom, in CSS pixels (0 while hidden). */
    var tabBarInset: Double = 0.0
        private set

    // Mirrored so the chrome can be rebuilt on a theme change without the web
    // app having to send its state again.
    private var titles: Map<String, String> = emptyMap()
    private var selectedTab: String = tabIds.first()
    // Both bars start hidden: a wide (desktop) layout configures neither, and
    // a bar that appeared before the web app asked for it would flash on boot.
    private var tabBarHidden = true
    private var topBarMode = TopBarMode.HIDDEN
    private var topBarTitle = "operon"
    private var topBarSubtitle: String? = null
    private var topBarUnread = false
    private var topBarInteractive = true
    private var dark = false

    private var root: ViewGroup? = null
    private var topBarContainer: LinearLayout? = null
    private var topBar: MaterialToolbar? = null
    private var topBarDivider: View? = null
    private var contextButton: MaterialButton? = null
    private var tabBarContainer: LinearLayout? = null
    private var navBand: View? = null
    private var tabBar: BottomNavigationView? = null

    private var statusInset = 0
    private var navInset = 0
    /** Set from the JS side's point of view, so a no-op re-send stays a no-op. */
    private var appliedWebViewTopMargin = -1
    private var appliedWebViewBottomMargin = -1

    // `webview` is declared by capacitor-android's own layout, so the id lives
    // in its R, not the app's.
    private val webView: View?
        get() = activity.findViewById(com.getcapacitor.android.R.id.webview)

    private val host: ViewGroup?
        get() = webView?.parent as? ViewGroup

    fun attach() {
        if (root != null) return
        val host = host ?: return
        val view = inflate()
        host.addView(view)
        root = view
        bind(view)
        applyAll()
    }

    /**
     * Light / dark for the native surfaces, following the app's own theme
     * rather than the system's.
     *
     * Rebuilding is the point: `AppCompatDelegate.setDefaultNightMode` would
     * recreate the activity, and that takes the web view — and everything the
     * user had open in it — down with it. Re-inflating against the other theme
     * leaves the web view untouched, and the chrome carries no state that is
     * not mirrored above.
     */
    fun setAppearance(dark: Boolean) {
        if (this.dark == dark && root != null) return
        this.dark = dark
        themedContext = null
        val host = host ?: return
        root?.let { host.removeView(it) }
        val view = inflate()
        host.addView(view)
        root = view
        bind(view)
        applyAll()
    }

    private var themedContext: Context? = null

    /**
     * A context themed for the app's own light/dark setting rather than the
     * system's. Rebuilt whenever that setting changes, and cached in between
     * because colours are read on every bar update.
     *
     * Two themes, not one theme with the configuration's night bit overridden
     * — see [SheetUi.themed] and attrs_operon.xml.
     */
    private fun themedContext(): Context = themedContext ?: ContextThemeWrapper(
        activity,
        if (dark) R.style.Theme_Operon_Shell_Dark else R.style.Theme_Operon_Shell,
    ).also { themedContext = it }

    private fun inflate(): ViewGroup =
        LayoutInflater.from(themedContext())
            .inflate(R.layout.operon_shell_chrome, host, false) as ViewGroup

    private fun bind(view: ViewGroup) {
        topBarContainer = view.findViewById(R.id.operon_top_bar_container)
        topBar = view.findViewById(R.id.operon_top_bar)
        topBarDivider = view.findViewById(R.id.operon_top_bar_divider)
        contextButton = view.findViewById(R.id.operon_context_button)
        tabBarContainer = view.findViewById(R.id.operon_tab_bar_container)
        navBand = view.findViewById(R.id.operon_nav_band)
        tabBar = view.findViewById(R.id.operon_tab_bar)

        contextButton?.setOnClickListener {
            if (topBarInteractive) onTopBarAction?.invoke("context")
        }

        topBar?.apply {
            inflateMenu(R.menu.operon_top_bar)
            setOnMenuItemClickListener {
                if (topBarInteractive) onTopBarAction?.invoke("inbox")
                true
            }
            setNavigationOnClickListener {
                if (topBarInteractive) onTopBarAction?.invoke("back")
            }
        }

        tabBar?.setOnItemSelectedListener { item ->
            val index = tabMenuIds.indexOf(item.itemId)
            if (index >= 0) {
                // Only a real change is reported: reselecting the current tab
                // is how the web app's own mirror lands back here.
                if (tabIds[index] != selectedTab) {
                    selectedTab = tabIds[index]
                    onTabSelected?.invoke(selectedTab)
                }
                true
            } else {
                false
            }
        }

        // Listen on the host rather than on the chrome: insets are dispatched
        // down the tree in child order, and the web view — which the StatusBar
        // plugin puts into overlay mode — is the earlier sibling. Watching
        // from above means the status bar height is read before anyone has had
        // a chance to consume it. The insets are passed straight back through,
        // so the web view still gets its own.
        host?.let { host ->
            ViewCompat.setOnApplyWindowInsetsListener(host) { _, insets ->
                val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
                statusInset = bars.top
                navInset = bars.bottom
                topBarContainer?.setPadding(0, statusInset, 0, 0)
                navBand?.updateLayoutParams { height = navInset }
                syncWebViewInset()
                reportTabBarInset()
                insets
            }
            ViewCompat.requestApplyInsets(host)
        }

        // The bars' heights are only known after layout, and the tab bar's
        // changes when the system gesture inset does.
        tabBarContainer?.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> reportTabBarInset() }
        topBarContainer?.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> syncWebViewInset() }
    }

    private fun applyAll() {
        applyTitles()
        applySelection()
        applyTabBarVisibility()
        applyTopBar()
    }

    // MARK: - Driven by the plugin

    fun setTitles(titles: Map<String, String>) {
        this.titles = titles
        applyTitles()
    }

    private fun applyTitles() {
        val bar = tabBar ?: return
        tabIds.forEachIndexed { index, id ->
            titles[id]?.let { bar.menu.findItem(tabMenuIds[index])?.title = it }
        }
    }

    fun select(tabId: String) {
        if (tabId == selectedTab || tabId !in tabIds) return
        selectedTab = tabId
        applySelection()
    }

    private fun applySelection() {
        val index = tabIds.indexOf(selectedTab)
        if (index < 0) return
        val bar = tabBar ?: return
        // Assigning selectedItemId re-enters the listener; it compares against
        // `selectedTab`, which is already up to date, so nothing is reported.
        if (bar.selectedItemId != tabMenuIds[index]) bar.selectedItemId = tabMenuIds[index]
    }

    fun setTabBarHidden(hidden: Boolean) {
        if (hidden == tabBarHidden) return
        tabBarHidden = hidden
        applyTabBarVisibility()
    }

    private fun applyTabBarVisibility() {
        tabBarContainer?.visibility = if (tabBarHidden) View.GONE else View.VISIBLE
        reportTabBarInset()
    }

    /**
     * How much of the *web view* the tab bar covers, which is its height minus
     * the gesture-bar inset it pads itself by — that part hangs below the web
     * view, which [syncWebViewInset] has already pulled up.
     */
    private fun reportTabBarInset() {
        val container = tabBarContainer
        val height = if (tabBarHidden || container == null) 0 else (container.height - navInset)
        val inset = height.coerceAtLeast(0) / activity.resources.displayMetrics.density.toDouble()
        if (inset != tabBarInset) {
            tabBarInset = inset
            onTabBarInsetChanged?.invoke(inset)
        }
    }

    /**
     * `interactive: false` while a web overlay is up. On iOS the bar keeps its
     * place and only stops taking taps, because the overlay's scrim is drawn
     * inside the web view and cannot cover a native bar. Here the top bar is
     * outside the web view's box entirely, so there is nothing for the scrim
     * to be under; not taking taps is the whole of it.
     */
    fun setTopBar(mode: TopBarMode, title: String, subtitle: String?, unread: Boolean, interactive: Boolean) {
        topBarMode = mode
        topBarTitle = title
        topBarSubtitle = subtitle
        topBarUnread = unread
        topBarInteractive = interactive
        applyTopBar()
    }

    /**
     * The container is always visible and always painted, even in `hidden`
     * mode where it is nothing but the status bar band. That band is the
     * difference from iOS: there, the web view draws under the status bar and
     * pads itself with `env(safe-area-inset-top)`; here the shell keeps the
     * status bar clear itself, so the band needs a colour or the window
     * background shows through it — which is a fixed dark value, wrong under a
     * light theme.
     */
    private fun applyTopBar() {
        val bar = topBar ?: return
        val container = topBarContainer ?: return
        val button = contextButton ?: return
        val inboxItem = bar.menu.findItem(R.id.operon_action_inbox)

        container.visibility = View.VISIBLE
        container.setBackgroundColor(color(R.attr.operonBackground))

        when (topBarMode) {
            TopBarMode.HIDDEN -> {
                bar.visibility = View.GONE
                topBarDivider?.visibility = View.GONE
            }
            TopBarMode.CONTEXT -> {
                bar.visibility = View.VISIBLE
                topBarDivider?.visibility = View.VISIBLE
                bar.navigationIcon = null
                button.visibility = View.VISIBLE
                button.text = topBarSubtitle?.let { "$topBarTitle › $it" } ?: topBarTitle
                inboxItem?.isVisible = true
                inboxItem?.icon = tinted(if (topBarUnread) R.drawable.ic_bell_dot else R.drawable.ic_bell)
            }
            TopBarMode.BACK -> {
                // iOS floats a lone back button and lets the conversation
                // scroll under it. Android does not: a screen you can go back
                // from carries a real top app bar with the arrow in it, and
                // making one float would also mean relying on the web view's
                // `env(safe-area-inset-top)`, which on Android reports the
                // display cutout and not the status bar.
                bar.visibility = View.VISIBLE
                topBarDivider?.visibility = View.VISIBLE
                bar.navigationIcon = tinted(R.drawable.ic_arrow_left)
                bar.navigationContentDescription = activity.getString(R.string.operon_back)
                button.visibility = View.GONE
                inboxItem?.isVisible = false
            }
        }
        syncWebViewInset()
    }

    /**
     * Keep the web view clear of the system's own furniture.
     *
     * Top: the status bar band plus whatever the top app bar currently is.
     * Bottom: the navigation or gesture bar. iOS gets the latter for free, as
     * `env(safe-area-inset-bottom)` is the home indicator; on Android that
     * value is zero, and without this the composer sat on top of the gesture
     * bar whenever the tab bar was hidden. The tab bar itself still floats over
     * the web view and is accounted for by [reportTabBarInset].
     */
    private fun syncWebViewInset() {
        val web = webView ?: return
        val container = topBarContainer
        val barHeight = if (container != null) {
            (container.height - statusInset).coerceAtLeast(0)
        } else {
            0
        }
        val top = statusInset + barHeight
        if (top == appliedWebViewTopMargin && navInset == appliedWebViewBottomMargin) return
        appliedWebViewTopMargin = top
        appliedWebViewBottomMargin = navInset
        web.updateLayoutParams<ViewGroup.MarginLayoutParams> {
            topMargin = top
            bottomMargin = navInset
        }
    }

    private fun color(attr: Int): Int = with(SheetUi) { themedContext().color(attr) }

    /**
     * The icons are white-stroked vectors, tinted where they are used. A
     * toolbar's navigation and menu icons are not covered by the `style`'s
     * `colorControlNormal` — that reads from the *theme* — so untinted they
     * came out white on a white bar, which looked exactly like a missing icon.
     */
    private fun tinted(id: Int): Drawable? =
        androidx.appcompat.content.res.AppCompatResources.getDrawable(themedContext(), id)?.mutate()?.also {
            DrawableCompat.setTint(it, color(R.attr.operonForeground))
        }
}
