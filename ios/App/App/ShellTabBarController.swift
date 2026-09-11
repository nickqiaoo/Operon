import UIKit
import Capacitor

/// Root of the iOS app: the Capacitor web view filling the screen, with the
/// system tab bar and navigation bar floating over it as a transparent
/// overlay (`ShellChromeController`).
///
/// Why an overlay, not containment: the web view must never move. Every
/// arrangement that makes it a child of the tab bar controller either gives it
/// a zero safe area (UITabBarController only propagates insets to the child it
/// manages) or requires re-parenting it on each tab switch — and re-parenting a
/// `WKWebView` drops it out of the window for a moment, WebKit re-hosts its
/// layer tree, and both glass bars flash dark as they refract the web view's
/// background color. So the web view is a plain child of this controller and
/// the chrome is a second, full-screen child stacked on top whose empty areas
/// let touches through (`PassthroughHostView`).
///
/// Why `UITabBarController` at all and not SwiftUI's `TabView`: it is the same
/// system bar `TabView` is built on, gets Liquid Glass on iOS 26 for free (the
/// app is compiled against the iOS 26 SDK), and, unlike `TabView`, tolerates
/// having no real content per tab.
///
/// The web side hides its own bars when `NativeShell` is available and mirrors
/// its state over the plugin (`NativeShellPlugin.swift`).
final class ShellRootController: UIViewController {
    let bridgeController = BridgeViewController()
    let chrome = ShellChromeController()
    private let chromeHost = PassthroughHostView()

    override func viewDidLoad() {
        super.viewDidLoad()

        addChild(bridgeController)
        let webView = bridgeController.view!
        // Frame + autoresizing rather than constraints: the StatusBar and
        // Keyboard plugins assign `webView.frame` directly, and constraints
        // would silently fight them.
        webView.frame = view.bounds
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(webView)
        bridgeController.didMove(toParent: self)

        // iOS 26 gives every UIScrollView a scroll-edge effect on the edges a
        // floating bar overlaps, WKWebView's inner scroll view included: a
        // `ScrollEdgeEffectView` fading the page towards the web view's (dark)
        // background color. The page scrolls in the DOM, not in that scroll
        // view (`scrollEnabled: false` in the Capacitor config).
        if #available(iOS 26.0, *), let scrollView = bridgeController.webView?.scrollView {
            for effect in [scrollView.topEdgeEffect, scrollView.bottomEdgeEffect, scrollView.leftEdgeEffect, scrollView.rightEdgeEffect] {
                effect.isHidden = true
            }
        }

        addChild(chrome)
        chromeHost.frame = view.bounds
        chromeHost.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        chrome.view.frame = chromeHost.bounds
        chrome.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        chrome.view.backgroundColor = .clear
        chromeHost.addSubview(chrome.view)
        view.addSubview(chromeHost)
        chrome.didMove(toParent: self)

        chrome.onTopBarInsetChanged = { [weak self] inset in
            guard let self else { return }
            // The web view's own safe area is the status bar / home indicator;
            // the navigation bar is added here so `env(safe-area-inset-top)`
            // includes it, exactly as it would under a real navigation
            // controller. The tab bar's height travels over the plugin instead.
            var insets = self.bridgeController.additionalSafeAreaInsets
            insets.top = inset
            self.bridgeController.additionalSafeAreaInsets = insets
        }
    }

    /// The app has its own light/dark setting (web `theme-store`), which need
    /// not match the OS. Native chrome and sheets must follow the app, or a
    /// dark page gets a light sheet and a grey-on-black title. Applied to the
    /// window so presented sheets inherit it too.
    private var appearance: UIUserInterfaceStyle = .unspecified

    func setAppearance(dark: Bool) {
        appearance = dark ? .dark : .light
        applyAppearance()
    }

    private func applyAppearance() {
        overrideUserInterfaceStyle = appearance
        view.window?.overrideUserInterfaceStyle = appearance
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // The window is only attached now; an early `setAppearance` (before
        // first appearance) would otherwise miss it.
        applyAppearance()
    }

    // The bridge controller owns the status bar (the StatusBar plugin drives
    // its style with the app theme) and the orientation lock.
    override var childForStatusBarStyle: UIViewController? { bridgeController }
    override var childForStatusBarHidden: UIViewController? { bridgeController }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { bridgeController.supportedInterfaceOrientations }
}

/// Hosts the chrome above the web view. Only the bars' controls take touches;
/// everything else in the overlay is see-through.
final class PassthroughHostView: UIView {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard let hit = super.hitTest(point, with: event) else { return nil }
        var candidate: UIView? = hit
        while let current = candidate {
            // Tab bar: the whole floating platter. Navigation bar: only its
            // buttons (the transparent middle must not swallow the page).
            if current is UITabBar || current is UIControl { return hit }
            candidate = current.superview
        }
        return nil
    }
}

/// The tab bar + navigation bar, and nothing else. One navigation controller
/// (one bar, shared by every tab) wrapping one tab bar controller whose four
/// tabs are empty transparent controllers.
///
/// One bar, not one per tab: with a navigation controller *per tab*, a tab
/// switch swapped in a freshly attached navigation bar whose glass title and
/// bell rendered their first frame without a backdrop — a dark flash on every
/// switch. The tab bar never flashed for exactly the reason it is shared.
final class ShellChromeController: UINavigationController {
    let tabsController = ShellTabsController()

    /// Fired when the user taps a tab. Wired by the plugin.
    var onTabSelected: ((String) -> Void)? {
        get { tabsController.onTabSelected }
        set { tabsController.onTabSelected = newValue }
    }
    /// Fired when the user taps something in the top bar: `context` (the
    /// project / workspace title), `inbox` (the bell) or `back`.
    var onTopBarAction: ((String) -> Void)?
    /// Space the tab bar takes from the bottom (0 while hidden).
    var onTabBarInsetChanged: ((CGFloat) -> Void)? {
        get { tabsController.onTabBarInsetChanged }
        set { tabsController.onTabBarInsetChanged = newValue }
    }
    /// Height of the navigation bar (0 while hidden).
    var onTopBarInsetChanged: ((CGFloat) -> Void)?

    var tabBarInset: CGFloat { tabsController.tabBarInset }
    private(set) var topBarInset: CGFloat = 0
    // Hidden until the web app asks for it: the desktop layout (wide
    // viewports) has no top bar, and nobody there configures one.
    private var topBarMode: TopBarMode = .hidden
    private var wantsTopBarHidden: Bool { topBarMode == .hidden }

    init() {
        super.init(rootViewController: tabsController)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        setNavigationBarHidden(true, animated: false)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // Only the title bar pushes the page down. In `back` mode the bar is a
        // lone floating button and the conversation scrolls under it — an
        // inset there left a blank band above the transcript.
        let top = topBarMode == .context ? navigationBar.frame.height : 0
        if top != topBarInset {
            topBarInset = top
            onTopBarInsetChanged?(top)
        }
    }

    // MARK: - Driven by the plugin

    func setTitles(_ titles: [String: String]) { tabsController.setTitles(titles) }
    func select(tabId: String) { tabsController.select(tabId: tabId) }
    func setTabBarHidden(_ hidden: Bool) { tabsController.setTabBarHidden(hidden) }

    /// What the top bar shows. Mirrors the web shell's own state: the
    /// project/workspace title with the inbox bell on list screens, a lone
    /// back button over an open conversation, or nothing.
    enum TopBarMode: String {
        case hidden, context, back
    }

    private lazy var titleButton: UIButton = {
        var config: UIButton.Configuration
        if #available(iOS 26.0, *) {
            config = .glass()
        } else {
            config = .plain()
        }
        config.imagePlacement = .trailing
        config.imagePadding = 4
        config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 11, weight: .semibold)
        config.image = UIImage(systemName: "chevron.down")
        config.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 10)
        // One line, truncated: a long project name wrapped the capsule onto two
        // lines. The bar hands the title view whatever is left between the
        // bell and the leading edge, and the button must shrink into it.
        config.titleLineBreakMode = .byTruncatingTail
        let button = UIButton(configuration: config)
        button.titleLabel?.numberOfLines = 1
        button.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        button.widthAnchor.constraint(lessThanOrEqualToConstant: 260).isActive = true
        button.addAction(UIAction { [weak self] _ in self?.onTopBarAction?("context") }, for: .touchUpInside)
        return button
    }()

    /// `interactive: false` while a web overlay (sheet) is up: its scrim is
    /// drawn inside the web view, under the bar, so the bar must at least stop
    /// taking taps. Hiding it instead would shrink the safe area and shift the
    /// page under the scrim.
    func setTopBar(mode: TopBarMode, title: String, subtitle: String?, unread: Bool, interactive: Bool) {
        topBarMode = mode
        setNavigationBarHidden(mode == .hidden, animated: true)
        navigationBar.isUserInteractionEnabled = interactive

        let item = tabsController.navigationItem
        switch mode {
        case .hidden:
            break
        case .context:
            var config = titleButton.configuration ?? .plain()
            let text = subtitle.map { "\(title) › \($0)" } ?? title
            var attributed = AttributedString(text)
            attributed.font = .systemFont(ofSize: 15, weight: .semibold)
            config.attributedTitle = attributed
            titleButton.configuration = config
            item.titleView = titleButton
            item.leftBarButtonItem = nil
            let bell = UIBarButtonItem(
                image: UIImage(systemName: unread ? "bell.badge" : "bell"),
                primaryAction: UIAction { [weak self] _ in self?.onTopBarAction?("inbox") }
            )
            bell.accessibilityLabel = "Inbox"
            item.rightBarButtonItem = bell
        case .back:
            item.titleView = nil
            item.rightBarButtonItem = nil
            let back = UIBarButtonItem(
                image: UIImage(systemName: "chevron.left"),
                primaryAction: UIAction { [weak self] _ in self?.onTopBarAction?("back") }
            )
            back.accessibilityLabel = "Back"
            item.leftBarButtonItem = back
        }
        view.setNeedsLayout()
    }
}

/// The tab bar. Four tabs, each an empty transparent controller.
final class ShellTabsController: UITabBarController, UITabBarControllerDelegate {
    /// Order must match `MobileTab` on the JS side.
    static let tabIds = ["chats", "channel", "changes", "more"]
    /// SF Symbols that exist back to the iOS 15 deployment target.
    private static let tabSymbols = ["message", "rectangle.3.group", "plus.forwardslash.minus", "ellipsis"]

    var onTabSelected: ((String) -> Void)?
    var onTabBarInsetChanged: ((CGFloat) -> Void)?
    private(set) var tabBarInset: CGFloat = 0
    // Hidden until the web app asks for it, same as the top bar.
    private var wantsTabBarHidden = true

    override func viewDidLoad() {
        super.viewDidLoad()
        delegate = self
        view.backgroundColor = .clear

        viewControllers = zip(Self.tabIds, Self.tabSymbols).enumerated().map { index, pair in
            let (id, symbol) = pair
            let tab = UIViewController()
            tab.view.backgroundColor = .clear
            // Placeholder caption; the localized one arrives via `configure`.
            tab.tabBarItem = UITabBarItem(title: id.capitalized, image: UIImage(systemName: symbol), tag: index)
            return tab
        }

        if #available(iOS 18.0, *) {
            setTabBarHidden(true, animated: false)
        } else {
            tabBar.isHidden = true
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let bottom = wantsTabBarHidden ? 0 : max(0, view.bounds.maxY - tabBar.frame.minY)
        if bottom != tabBarInset {
            tabBarInset = bottom
            onTabBarInsetChanged?(bottom)
        }
    }

    func setTitles(_ titles: [String: String]) {
        for (index, id) in Self.tabIds.enumerated() {
            guard let title = titles[id] else { continue }
            viewControllers?[index].tabBarItem.title = title
        }
    }

    func select(tabId: String) {
        guard let index = Self.tabIds.firstIndex(of: tabId), index != selectedIndex else { return }
        selectedIndex = index
    }

    func setTabBarHidden(_ hidden: Bool) {
        guard hidden != wantsTabBarHidden else { return }
        wantsTabBarHidden = hidden
        if #available(iOS 18.0, *) {
            setTabBarHidden(hidden, animated: true)
        } else {
            tabBar.isHidden = hidden
        }
        view.setNeedsLayout()
    }

    // MARK: - UITabBarControllerDelegate

    func tabBarController(_ tabBarController: UITabBarController, didSelect viewController: UIViewController) {
        let index = viewController.tabBarItem.tag
        guard Self.tabIds.indices.contains(index) else { return }
        onTabSelected?(Self.tabIds[index])
    }
}
