import UIKit
import Capacitor

/// Navigation bars decide overflow from `systemLayoutSizeFitting`, before any
/// width constraint is applied. A `UIButton` reports its full title there, so a
/// long Spec name measures at hundreds of points and UIKit folds the whole bar
/// into the "…" menu. Cap every measurement the bar reads.
private final class ContextSwitcherButton: UIButton {
    private let maximumWidth: CGFloat = 220

    override var intrinsicContentSize: CGSize {
        capped(super.intrinsicContentSize)
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        capped(super.sizeThatFits(size))
    }

    override func systemLayoutSizeFitting(
        _ targetSize: CGSize,
        withHorizontalFittingPriority horizontalFittingPriority: UILayoutPriority,
        verticalFittingPriority: UILayoutPriority
    ) -> CGSize {
        capped(super.systemLayoutSizeFitting(
            targetSize,
            withHorizontalFittingPriority: horizontalFittingPriority,
            verticalFittingPriority: verticalFittingPriority
        ))
    }

    private func capped(_ size: CGSize) -> CGSize {
        CGSize(width: min(size.width, maximumWidth), height: size.height)
    }
}

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
    /// project / workspace title), `inbox` (the bell), `back`, or in the
    /// assistant's bar `assistantProfile` (the capsule).
    var onTopBarAction: ((String) -> Void)?
    /// Height of the navigation bar whenever it is laid out while showing.
    /// For the bars that float over the page (`back`, `assistant`) the page
    /// pads its content by this itself, since the safe area does not grow.
    var onTopBarHeightChanged: ((CGFloat) -> Void)?
    private var reportedBarHeight: CGFloat = 0
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
        // Line the bar's outer items up with the floating tab bar below
        // instead of the default 16pt, which left the top row wider than the bottom.
        navigationBar.preservesSuperviewLayoutMargins = false
        navigationBar.directionalLayoutMargins = NSDirectionalEdgeInsets(
            top: 0, leading: Self.barSideInset, bottom: 0, trailing: Self.barSideInset)
    }

    /// The floating tab bar's distance from the screen's sides.
    private static let barSideInset: CGFloat = 21

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // Only the title bar pushes the page down. In `back` mode the bar is a
        // lone floating button and the conversation scrolls under it — an
        // inset there left a blank band above the transcript.
        // `header` floats too: its glass items sit over the list, which pads its
        // own first row below them and scrolls underneath (iOS 26's own layout).
        let top = topBarMode == .context ? navigationBar.frame.height : 0
        if top != topBarInset {
            topBarInset = top
            onTopBarInsetChanged?(top)
        }
        let barHeight = navigationBar.frame.height
        if !isNavigationBarHidden, barHeight > 0, barHeight != reportedBarHeight {
            reportedBarHeight = barHeight
            onTopBarHeightChanged?(barHeight)
        }
    }

    // MARK: - Driven by the plugin

    func setTabs(_ ids: [String]) { tabsController.setTabs(ids) }
    func setTitles(_ titles: [String: String]) { tabsController.setTitles(titles) }
    func select(tabId: String) { tabsController.select(tabId: tabId) }
    func setTabBarHidden(_ hidden: Bool) { tabsController.setTabBarHidden(hidden) }

    /// What the top bar shows. Mirrors the web shell's own state: the
    /// project/workspace title with the inbox bell on list screens, a lone
    /// back button over an open conversation, or nothing.
    enum TopBarMode: String {
        case hidden, context, back, assistant, header
    }

    /// `header` mode's contents, as the web page describes its one top row:
    /// context or a segmented switch on the leading side; a pull-down menu, the
    /// page's own actions and the bell on the trailing side. Taps come back as
    /// `context`, `segment:<id>`, `menu:<id>`, `action:<id>` and `inbox`.
    struct HeaderSpec {
        enum Leading {
            case context(title: String, subtitle: String?)
            case segments(items: [(id: String, title: String)], selected: String)
        }
        /// A choice (ticked when selected) or a group of them: a titled section
        /// in place (`inline`) or a submenu whose row shows its current choice.
        indirect enum MenuNode {
            case item(id: String, title: String, selected: Bool)
            case group(id: String, title: String, inline: Bool, detail: String?, children: [MenuNode])
        }
        struct Menu { let symbol: String; let label: String; let nodes: [MenuNode] }
        struct Action { let id: String; let symbol: String; let label: String }
        let leading: Leading
        let menu: Menu?
        let actions: [Action]
        var back = false
    }

    /// The leading project › workspace switcher: left-aligned, as wide as its text.
    /// Plain, not `.glass()`: on iOS 26 the bar already sets every bar item on
    /// its own glass, and a glass button inside it drew a capsule in a capsule.
    private lazy var leadingContextButton: UIButton = {
        var config = UIButton.Configuration.plain()
        config.baseForegroundColor = .label
        config.imagePlacement = .trailing
        config.imagePadding = 4
        config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 11, weight: .semibold)
        config.image = UIImage(systemName: "chevron.down")
        config.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 10)
        config.titleLineBreakMode = .byTruncatingTail
        let button = ContextSwitcherButton(configuration: config)
        button.titleLabel?.numberOfLines = 1
        button.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        button.widthAnchor.constraint(lessThanOrEqualToConstant: 220).isActive = true
        button.addAction(UIAction { [weak self] _ in self?.onTopBarAction?("context") }, for: .touchUpInside)
        return button
    }()

    private lazy var segmentedControl: UISegmentedControl = {
        let control = UISegmentedControl()
        control.addAction(UIAction { [weak self, weak control] _ in
            guard let self, let control, control.selectedSegmentIndex >= 0,
                  control.selectedSegmentIndex < self.segmentIds.count else { return }
            self.onTopBarAction?("segment:\(self.segmentIds[control.selectedSegmentIndex])")
        }, for: .valueChanged)
        return control
    }()
    private var segmentIds: [String] = []

    /// A bar button for one of the page's actions: an SF Symbol, falling back
    /// to a plain circle should the web page name one this iOS lacks.
    private func actionItem(_ action: HeaderSpec.Action) -> UIBarButtonItem {
        let image = UIImage(systemName: action.symbol) ?? UIImage(systemName: "circle")
        let item = UIBarButtonItem(
            image: image,
            primaryAction: UIAction { [weak self] _ in self?.onTopBarAction?("action:\(action.id)") }
        )
        item.accessibilityLabel = action.label
        return item
    }

    private func menuElement(_ node: HeaderSpec.MenuNode) -> UIMenuElement {
        switch node {
        case let .item(id, title, selected):
            return UIAction(title: title, state: selected ? .on : .off) { [weak self] _ in
                self?.onTopBarAction?("menu:\(id)")
            }
        case let .group(_, title, inline, detail, children):
            let group = UIMenu(title: title, options: inline ? .displayInline : [], children: children.map(menuElement))
            if !inline, let detail { group.subtitle = detail }
            return group
        }
    }

    private func applyHeader(_ spec: HeaderSpec, unread: Bool, to item: UINavigationItem) {
        item.titleView = nil
        item.leftBarButtonItems = nil
        switch spec.leading {
        case let .context(title, subtitle):
            var config = leadingContextButton.configuration ?? .plain()
            var name = AttributedString(title)
            name.font = .systemFont(ofSize: 15, weight: .semibold)
            name.foregroundColor = .label
            if let subtitle {
                var rest = AttributedString(" › \(subtitle)")
                rest.font = .systemFont(ofSize: 14, weight: .regular)
                rest.foregroundColor = .secondaryLabel
                config.attributedTitle = name + rest
            } else {
                config.attributedTitle = name
            }
            leadingContextButton.configuration = config
            leadingContextButton.accessibilityLabel = subtitle.map { "\(title) › \($0)" } ?? title
            item.leftBarButtonItem = UIBarButtonItem(customView: leadingContextButton)
        case let .segments(items, selected):
            if segmentIds != items.map(\.id) || segmentedControl.numberOfSegments != items.count {
                segmentedControl.removeAllSegments()
                for (index, entry) in items.enumerated() {
                    segmentedControl.insertSegment(withTitle: entry.title, at: index, animated: false)
                }
                segmentIds = items.map(\.id)
            }
            segmentedControl.selectedSegmentIndex = segmentIds.firstIndex(of: selected) ?? UISegmentedControl.noSegment
            let segmentsItem = UIBarButtonItem(customView: segmentedControl)
            // The control draws its own track; the bar's glass around it would be a second one.
            if #available(iOS 26.0, *) {
                segmentsItem.hidesSharedBackground = true
            }
            item.leftBarButtonItem = segmentsItem
        }

        if spec.back {
            // Reuse the context capsule as the conversation switcher. Keeping
            // it in titleView lets UIKit truncate it between the back/action items.
            item.titleView = leadingContextButton
            let back = UIBarButtonItem(image: UIImage(systemName: "chevron.left"), primaryAction: UIAction { [weak self] _ in self?.onTopBarAction?("back") })
            back.accessibilityLabel = "Back"
            item.leftBarButtonItem = back
        }

        // Right to left: the bell outermost, then the page's actions, then the menu.
        let bell = UIBarButtonItem(
            image: UIImage(systemName: unread ? "bell.badge" : "bell"),
            primaryAction: UIAction { [weak self] _ in self?.onTopBarAction?("inbox") }
        )
        bell.accessibilityLabel = "Inbox"
        var trailing: [UIBarButtonItem] = spec.back ? [] : [bell]
        trailing.append(contentsOf: spec.actions.reversed().map(actionItem))
        if let menu = spec.menu, !menu.nodes.isEmpty {
            // A system pull-down: picked in place, the current choices ticked.
            let menuItem = UIBarButtonItem(
                title: nil,
                image: UIImage(systemName: menu.symbol) ?? UIImage(systemName: "line.3.horizontal.decrease.circle"),
                primaryAction: nil,
                menu: UIMenu(children: menu.nodes.map(menuElement))
            )
            menuItem.accessibilityLabel = menu.label
            trailing.append(menuItem)
        }
        item.rightBarButtonItems = trailing
    }

    /// The assistant tab's title: avatar and status in one glass capsule,
    /// floating over the thread (which scrolls under it, as in `back`).
    private lazy var assistantButton: UIButton = {
        var config: UIButton.Configuration
        if #available(iOS 26.0, *) {
            config = .glass()
        } else {
            config = .plain()
        }
        config.imagePlacement = .leading
        config.imagePadding = 8
        config.titleAlignment = .leading
        config.titlePadding = 1
        config.contentInsets = NSDirectionalEdgeInsets(top: 4, leading: 5, bottom: 4, trailing: 14)
        config.titleLineBreakMode = .byTruncatingTail
        config.subtitleLineBreakMode = .byTruncatingTail
        let button = UIButton(configuration: config)
        // One line each, always: left to wrap, a longer status ("Working on 1") broke into three
        // lines and blew the capsule up into a circle.
        button.titleLabel?.numberOfLines = 1
        button.subtitleLabel?.numberOfLines = 1
        button.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        button.widthAnchor.constraint(lessThanOrEqualToConstant: 240).isActive = true
        button.addAction(UIAction { [weak self] _ in self?.onTopBarAction?("assistantProfile") }, for: .touchUpInside)
        return button
    }()

    /// The assistant's initial in a filled circle, as the web page draws it.
    private func avatarImage(letter: String) -> UIImage {
        let size = CGSize(width: 30, height: 30)
        let image = UIGraphicsImageRenderer(size: size).image { _ in
            UIColor.tertiarySystemFill.setFill()
            UIBezierPath(ovalIn: CGRect(origin: .zero, size: size)).fill()
            let text = NSAttributedString(string: letter, attributes: [
                .font: UIFont.systemFont(ofSize: 13, weight: .semibold),
                .foregroundColor: UIColor.label.withAlphaComponent(0.8),
            ])
            let bounds = text.size()
            text.draw(at: CGPoint(x: (size.width - bounds.width) / 2, y: (size.height - bounds.height) / 2))
        }
        // Not a template: the button would tint it flat.
        return image.withRenderingMode(.alwaysOriginal)
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
    func setTopBar(mode: TopBarMode, title: String, subtitle: String?, unread: Bool, interactive: Bool, busy: Bool = false, header: HeaderSpec? = nil, actions: [HeaderSpec.Action] = []) {
        topBarMode = mode
        setNavigationBarHidden(mode == .hidden, animated: true)
        navigationBar.isUserInteractionEnabled = interactive

        let item = tabsController.navigationItem
        // Only `header` uses more than one right item; the others set their own.
        if mode != .header { item.rightBarButtonItems = nil }
        switch mode {
        case .hidden:
            break
        case .header:
            if let header {
                applyHeader(header, unread: unread, to: item)
            }
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
        case .assistant:
            var config = assistantButton.configuration ?? .plain()
            // Idle is the usual state and says nothing worth a label: the name
            // then. Only while it works does the capsule show a status, its dot
            // a coloured glyph in the title rather than a view, so the capsule
            // stays a single system button.
            if busy {
                var dot = AttributedString("● ")
                dot.font = .systemFont(ofSize: 9)
                dot.foregroundColor = .systemOrange
                var status = AttributedString(subtitle ?? "")
                status.font = .systemFont(ofSize: 14, weight: .medium)
                status.foregroundColor = .secondaryLabel
                config.attributedTitle = dot + status
            } else {
                var name = AttributedString(title)
                name.font = .systemFont(ofSize: 15, weight: .semibold)
                name.foregroundColor = .label
                config.attributedTitle = name
            }
            config.attributedSubtitle = nil
            config.image = avatarImage(letter: String(title.prefix(1)).uppercased())
            assistantButton.configuration = config
            assistantButton.accessibilityLabel = [title, subtitle].compactMap { $0 }.joined(separator: ", ")
            item.titleView = assistantButton
            item.leftBarButtonItem = nil
            // The capsule is the only way in: it opens the assistant's page on
            // its Activity list, as Muse does.
            item.rightBarButtonItem = nil
        case .back:
            item.titleView = nil
            // Right to left, as in `header`.
            item.rightBarButtonItems = actions.reversed().map(actionItem)
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

/// The tab bar. One empty transparent controller per tab; which tabs show, and
/// in what order, is the web app's call (`configure`).
final class ShellTabsController: UITabBarController, UITabBarControllerDelegate {
    // Every tab the shell can draw is a `TabGlyph`; ids match `MobileTab` on
    // the JS side.
    /// Shown until `configure` says otherwise (and by a web bundle too old to say).
    private static let defaultTabIds = ["chats", "channel", "changes", "more"]

    private(set) var tabIds = ShellTabsController.defaultTabIds
    var onTabSelected: ((String) -> Void)?
    var onTabBarInsetChanged: ((CGFloat) -> Void)?
    private(set) var tabBarInset: CGFloat = 0
    // Hidden until the web app asks for it, same as the top bar.
    private var wantsTabBarHidden = true

    override func viewDidLoad() {
        super.viewDidLoad()
        delegate = self
        view.backgroundColor = .clear
        // Monochrome, as the web tab bar draws it, instead of the system blue:
        // the selected tab is the label colour and a filled glyph. iOS 26's
        // glass bar ignores the unselected tint (those stay label too, and the
        // glass capsule marks the selection); earlier versions use it.
        tabBar.tintColor = .label
        tabBar.unselectedItemTintColor = .secondaryLabel
        rebuildTabs()

        if #available(iOS 18.0, *) {
            setTabBarHidden(true, animated: false)
        } else {
            tabBar.isHidden = true
        }
    }

    private func rebuildTabs() {
        viewControllers = tabIds.enumerated().map { index, id in
            let tab = UIViewController()
            tab.view.backgroundColor = .clear
            // Placeholder caption; the localized one arrives via `configure`.
            let glyph = TabGlyph(rawValue: id)
            tab.tabBarItem = UITabBarItem(title: id.capitalized, image: glyph?.image(filled: false), tag: index)
            tab.tabBarItem.selectedImage = glyph?.image(filled: true)
            return tab
        }
    }

    /// The tabs to show, in order. Unknown ids are dropped; the selection
    /// follows its id across the rebuild.
    func setTabs(_ ids: [String]) {
        let next = ids.filter { TabGlyph(rawValue: $0) != nil }
        guard !next.isEmpty, next != tabIds else { return }
        let selectedId = tabIds.indices.contains(selectedIndex) ? tabIds[selectedIndex] : nil
        tabIds = next
        rebuildTabs()
        if let selectedId, let index = tabIds.firstIndex(of: selectedId) {
            selectedIndex = index
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
        for (index, id) in tabIds.enumerated() {
            guard let title = titles[id] else { continue }
            viewControllers?[index].tabBarItem.title = title
        }
    }

    func select(tabId: String) {
        guard let index = tabIds.firstIndex(of: tabId), index != selectedIndex else { return }
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
        guard tabIds.indices.contains(index) else { return }
        onTabSelected?(tabIds[index])
    }
}
