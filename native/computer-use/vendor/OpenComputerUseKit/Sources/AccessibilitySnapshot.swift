import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

final class ElementRecord {
    let index: Int
    let identifier: String?
    let element: AXUIElement?
    let localFrame: CGRect?
    let rawActions: [String]
    let prettyActions: [String]
    let isSyntheticText: Bool
    let role: String?
    let title: String?

    init(
        index: Int,
        identifier: String?,
        element: AXUIElement?,
        localFrame: CGRect?,
        rawActions: [String],
        prettyActions: [String],
        isSyntheticText: Bool = false,
        role: String? = nil,
        title: String? = nil
    ) {
        self.index = index
        self.identifier = identifier
        self.element = element
        self.localFrame = localFrame
        self.rawActions = rawActions
        self.prettyActions = prettyActions
        self.isSyntheticText = isSyntheticText
        self.role = role
        self.title = title
    }
}

enum SnapshotMode {
    case accessibility
    case fixture
}

public struct AccessibilityTreeLimits: Equatable, Sendable {
    public static let defaultMaxNodeCount = 1200
    public static let defaultMaxDepth = 64
    public static let defaults = AccessibilityTreeLimits(
        maxNodeCount: defaultMaxNodeCount,
        maxDepth: defaultMaxDepth
    )

    public let maxNodeCount: Int
    public let maxDepth: Int

    public init(maxNodeCount: Int = defaultMaxNodeCount, maxDepth: Int = defaultMaxDepth) {
        self.maxNodeCount = maxNodeCount
        self.maxDepth = maxDepth
    }

    public func replacing(maxNodeCount: Int? = nil, maxDepth: Int? = nil) -> AccessibilityTreeLimits {
        AccessibilityTreeLimits(
            maxNodeCount: maxNodeCount ?? self.maxNodeCount,
            maxDepth: maxDepth ?? self.maxDepth
        )
    }
}

@usableFromInline
let defaultTextLimit = 500

public struct SnapshotTextLimit: Equatable, Sendable {
    public static let maxKeyword = "max"
    public static let defaults = SnapshotTextLimit(maxCount: defaultTextLimit)
    public static let max = SnapshotTextLimit(maxCount: nil)

    public let maxCount: Int?

    public init(maxCount: Int = defaultTextLimit) {
        precondition(maxCount > 0, "text limit must be positive")
        self.maxCount = maxCount
    }

    private init(maxCount: Int?) {
        self.maxCount = maxCount
    }
}

let accessibilityTreeMaxNodeCount = AccessibilityTreeLimits.defaultMaxNodeCount
let accessibilityTreeMaxDepth = AccessibilityTreeLimits.defaultMaxDepth
let screenshotCaptureTimeout: TimeInterval = 5
let screenshotResultMaxBytes = 900_000
/// Screenshots are JPEG. The reference encoding supports both JPEG and PNG, and
/// encodes through
/// `ImageDestination.add(image:compressionQuality:)` with
/// `kCGImageDestinationLossyCompressionQuality` — and the bytes a real Codex
/// session returns start with `FF D8 FF`. The exact quality constant is passed
/// in from the caller and was not extracted, so this value is ours: high enough
/// that small UI text stays legible to the model.
let screenshotJPEGCompressionQuality: CGFloat = 0.8
let screenshotResultMaxDimension: CGFloat = 1280
let screenshotResultMinScale: CGFloat = 0.25
private let windowVisibilityRecoveryDelay: TimeInterval = 0.7
private let windowStartupTimeout: TimeInterval = 1
private let windowStartupPollInterval: TimeInterval = 0.1
private let webAccessibilitySettleDelay: TimeInterval = 1.2
private let axWebAreaRole = "AXWebArea"
private let axContentsAttribute = "AXContents"
private let axVisibleChildrenAttribute = "AXVisibleChildren"

public struct AppSnapshot {
    public let app: RunningAppDescriptor
    public let windowTitle: String?
    public let windowBounds: CGRect?
    let targetWindowID: CGWindowID?
    let targetWindowLayer: Int?
    public let screenshotImageData: Data?
    let mode: SnapshotMode
    let treeLines: [String]
    let focusedSummary: String?
    let focusedElement: AXUIElement?
    let selectedText: String?

    let elements: [Int: ElementRecord]

    var containsWebArea: Bool {
        elements.values.contains { $0.role == axWebAreaRole }
    }

    /// Same snapshot with a screenshot attached. Used when the tree turns out to
    /// be already hydrated, so the settle pass that would normally have taken the
    /// screenshot never runs.
    func withScreenshotImageData(_ data: Data?) -> AppSnapshot {
        AppSnapshot(
            app: app,
            windowTitle: windowTitle,
            windowBounds: windowBounds,
            targetWindowID: targetWindowID,
            targetWindowLayer: targetWindowLayer,
            screenshotImageData: data,
            mode: mode,
            treeLines: treeLines,
            focusedSummary: focusedSummary,
            focusedElement: focusedElement,
            selectedText: selectedText,
            elements: elements
        )
    }

    /// True when the AX tree already has real app content (not just chrome).
    /// Used to skip re-hydration work that can visually flash Electron windows.
    var looksHydrated: Bool {
        if containsWebArea, elements.count >= 40 {
            return true
        }
        let text = treeLines.joined(separator: "\n")
        // Require substantive UI, not a bare HTML shell with only window chrome.
        if (text.contains("会话列表")
            || text.localizedCaseInsensitiveContains("Rich Text")
            || text.contains("消息列表"))
            && elements.count >= 30
        {
            return true
        }
        if (text.contains("HTML 内容")
            || text.localizedCaseInsensitiveContains("HTML content")
            || text.contains("AXWebArea"))
            && elements.count >= 50
        {
            return true
        }
        return elements.count >= 80
    }

    public var renderedText: String {
        renderedText(style: .fullState)
    }

    public func renderedText(style: SnapshotTextStyle) -> String {
        var lines: [String] = []
        let displayTitle = displayWindowTitle(windowTitle, appName: app.name)
        let appReference = app.bundleIdentifier ?? app.name

        lines.append("App=\(appReference) (pid \(app.pid))")
        lines.append("Window: \(quoted(displayTitle)), App: \(app.name).")
        lines.append(contentsOf: treeLines)

        if let selectedText, !selectedText.isEmpty {
            lines.append("")
            lines.append("Selected text: [\(selectedText)]")
        } else if let focusedSummary {
            lines.append("")
            lines.append("The focused UI element is \(focusedSummary).")
        }

        return lines.joined(separator: "\n")
    }
}

public enum SnapshotTextStyle {
    case fullState
    case actionResult
}

enum SnapshotBuilder {
    static func build(
        for app: RunningAppDescriptor,
        session providedSession: AccessibilitySession? = nil,
        textLimit: SnapshotTextLimit = .defaults,
        treeLimits: AccessibilityTreeLimits = .defaults,
        captureScreenshot: Bool = true,
        settleWebAccessibility: Bool = true
    ) throws -> AppSnapshot {
        if app.name == FixtureBridge.appName, let fixtureState = try FixtureBridge.readState() {
            return buildFixtureSnapshot(app: app, state: fixtureState)
        }

        let permissions = PermissionDiagnostics.current()
        guard permissions.accessibilityTrusted else {
            throw ComputerUseError.permissionDenied("Accessibility permission is required. Run `open-computer-use doctor` and grant access to Open Computer Use.")
        }

        let session = providedSession ?? AccessibilitySession(app: app)
        let shouldCaptureScreenshot = captureScreenshot
            && ProcessInfo.processInfo.environment["OPERON_CU_DISABLE_SCREENSHOT_CAPTURE"] != "1"
        let enablement = session.refreshAccessibilityEnablement()
        let appElement = session.appElement
        let systemWide = session.systemWideElement
        // Codex skyshot read path: accessibility enablement + AX/CG window
        // discovery only. No SyntheticAppFocusEnforcer / notifyAppActivated*
        // (those belong on prepareToInteract).
        var focusedApplication = copyElement(systemWide, attribute: kAXFocusedApplicationAttribute)
        var focusedWindow = preferredFocusedWindow(appElement: appElement, appPID: app.pid, focusedApplication: focusedApplication, systemWide: systemWide)
        if focusedWindow == nil {
            focusedWindow = session.recoverWindowFromCGWindow()
        }
        if focusedWindow == nil {
            _ = recoverVisibleWindow(for: app, appElement: appElement, preferredWindow: nil)
            focusedApplication = copyElement(systemWide, attribute: kAXFocusedApplicationAttribute)
            focusedWindow = waitForUsableWindow(
                appElement: appElement,
                appPID: app.pid,
                focusedApplication: focusedApplication,
                systemWide: systemWide
            ) ?? session.recoverWindowFromCGWindow()
        }

        var rootWindow: AXUIElement
        guard let resolvedFocusedWindow = focusedWindow else {
            throw ComputerUseError.stateUnavailable(computerUseNoWindowFoundMessage)
        }
        rootWindow = resolvedFocusedWindow
        session.observe(window: rootWindow)

        var windowTitle = stringValue(of: rootWindow, attribute: kAXTitleAttribute)
        let shouldSettleWebTree = settleWebAccessibility
            && shouldSettleWebAccessibility(enablement: enablement)
        var windowCapture = WindowCapture.resolve(
            for: app.pid,
            titleHint: windowTitle,
            frameHint: globalFrame(of: rootWindow),
            captureScreenshot: shouldCaptureScreenshot && !shouldSettleWebTree
        )
        if windowCapture == nil || (shouldCaptureScreenshot && windowCapture?.image == nil) {
            _ = recoverVisibleWindow(for: app, appElement: appElement, preferredWindow: rootWindow)
            focusedApplication = copyElement(systemWide, attribute: kAXFocusedApplicationAttribute)
            if let recoveredWindow = preferredFocusedWindow(
                appElement: appElement,
                appPID: app.pid,
                focusedApplication: focusedApplication,
                systemWide: systemWide
            ) ?? session.recoverWindowFromCGWindow() {
                rootWindow = recoveredWindow
                session.observe(window: recoveredWindow)
                windowTitle = stringValue(of: recoveredWindow, attribute: kAXTitleAttribute)
            }
            windowCapture = WindowCapture.resolve(
                for: app.pid,
                titleHint: windowTitle,
                frameHint: globalFrame(of: rootWindow),
                captureScreenshot: shouldCaptureScreenshot && !shouldSettleWebTree
            )
        }

        guard let windowCapture else {
            throw ComputerUseError.stateUnavailable(computerUseNoWindowFoundMessage)
        }

        let initialSnapshot = buildAccessibilitySnapshot(
            app: app,
            appElement: appElement,
            rootElement: rootWindow,
            windowTitle: windowTitle,
            windowCapture: windowCapture,
            focusedApplication: focusedApplication,
            systemWide: systemWide,
            textLimit: textLimit,
            treeLimits: treeLimits
        )
        return settleWebAccessibilityIfNeeded(
            initialSnapshot: initialSnapshot,
            app: app,
            session: session,
            rootWindow: rootWindow,
            textLimit: textLimit,
            treeLimits: treeLimits,
            shouldSettle: shouldSettleWebTree,
            captureScreenshot: shouldCaptureScreenshot
        )
    }

    private static func settleWebAccessibilityIfNeeded(
        initialSnapshot: AppSnapshot,
        app: RunningAppDescriptor,
        session: AccessibilitySession,
        rootWindow initialRootWindow: AXUIElement,
        textLimit: SnapshotTextLimit,
        treeLimits: AccessibilityTreeLimits,
        shouldSettle: Bool,
        captureScreenshot: Bool
    ) -> AppSnapshot {
        guard shouldSettle else {
            return initialSnapshot
        }

        // Codex: wait for web accessibility after enablement, then re-walk.
        // Do not post synthetic activation on the read/settle path.
        if initialSnapshot.looksHydrated {
            ComputerUseTrace.mark("settleWebAccessibility: skip (already hydrated)")
            // The first capture was deliberately skipped because a settle pass
            // was expected to take the screenshot after the web tree hydrated.
            // "Already hydrated" means that pass never runs — so without this,
            // every web/Electron app returns `screenshot: null` forever.
            guard captureScreenshot, initialSnapshot.screenshotImageData == nil else {
                return initialSnapshot
            }
            ComputerUseTrace.mark("settleWebAccessibility: capture for hydrated tree")
            let capture = WindowCapture.resolve(
                for: app.pid,
                titleHint: initialSnapshot.windowTitle,
                frameHint: globalFrame(of: initialRootWindow),
                captureScreenshot: true
            )
            return initialSnapshot.withScreenshotImageData(capture?.imageDataIfAvailable())
        }

        var rootWindow = initialRootWindow
        ComputerUseTrace.mark("settleWebAccessibility: wait after enablement")
        Thread.sleep(forTimeInterval: webAccessibilitySettleDelay)
        _ = session.refreshAccessibilityEnablement()

        let focusedApplication = copyElement(
            session.systemWideElement,
            attribute: kAXFocusedApplicationAttribute
        )
        if let refreshedWindow = preferredFocusedWindow(
            appElement: session.appElement,
            appPID: app.pid,
            focusedApplication: focusedApplication,
            systemWide: session.systemWideElement
        ) ?? session.recoverWindowFromCGWindow() {
            rootWindow = refreshedWindow
            session.observe(window: refreshedWindow)
        }

        return finalSnapshot(
            fallback: initialSnapshot,
            app: app,
            session: session,
            rootWindow: rootWindow,
            focusedApplication: focusedApplication,
            textLimit: textLimit,
            treeLimits: treeLimits,
            captureScreenshot: captureScreenshot
        )
    }

    private static func finalSnapshot(
        fallback: AppSnapshot,
        app: RunningAppDescriptor,
        session: AccessibilitySession,
        rootWindow: AXUIElement,
        focusedApplication: AXUIElement?,
        textLimit: SnapshotTextLimit,
        treeLimits: AccessibilityTreeLimits,
        captureScreenshot: Bool
    ) -> AppSnapshot {
        let windowTitle = stringValue(of: rootWindow, attribute: kAXTitleAttribute)
        guard let capture = WindowCapture.resolve(
            for: app.pid,
            titleHint: windowTitle,
            frameHint: globalFrame(of: rootWindow),
            captureScreenshot: captureScreenshot
        ) else {
            return fallback
        }
        return buildAccessibilitySnapshot(
            app: app,
            appElement: session.appElement,
            rootElement: rootWindow,
            windowTitle: windowTitle,
            windowCapture: capture,
            focusedApplication: focusedApplication,
            systemWide: session.systemWideElement,
            textLimit: textLimit,
            treeLimits: treeLimits
        )
    }

    private static func buildAccessibilitySnapshot(
        app: RunningAppDescriptor,
        appElement: AXUIElement,
        rootElement: AXUIElement,
        windowTitle: String?,
        windowCapture: WindowCapture,
        focusedApplication: AXUIElement?,
        systemWide: AXUIElement,
        textLimit: SnapshotTextLimit,
        treeLimits: AccessibilityTreeLimits
    ) -> AppSnapshot {
        let windowBounds = windowCapture.bounds
        let screenshotImageData = windowCapture.imageDataIfAvailable()
        let focusedElement = preferredFocusedElement(appElement: appElement, appPID: app.pid, focusedApplication: focusedApplication, systemWide: systemWide)
        let selectedText = focusedElement.flatMap { copySelectedText($0, textLimit: textLimit) }
        let context = RenderContext(
            windowBounds: windowBounds,
            focusedElement: focusedElement,
            textLimit: textLimit,
            treeLimits: treeLimits
        )

        var renderer = TreeRenderer(context: context)
        renderer.render(rootElement)
        if let menuBar = copyElement(appElement, attribute: kAXMenuBarAttribute),
           !CFEqual(menuBar, rootElement)
        {
            renderer.render(menuBar)
        }

        return AppSnapshot(
            app: app,
            windowTitle: windowTitle,
            windowBounds: windowBounds,
            targetWindowID: windowCapture.windowID,
            targetWindowLayer: windowCapture.layer,
            screenshotImageData: screenshotImageData,
            mode: .accessibility,
            treeLines: renderer.lines,
            focusedSummary: renderer.focusedSummary,
            focusedElement: focusedElement,
            selectedText: selectedText,
            elements: renderer.records
        )
    }

    private static func recoverVisibleWindow(for app: RunningAppDescriptor, appElement: AXUIElement, preferredWindow: AXUIElement?) -> Bool {
        ComputerUseTrace.mark("recoverVisibleWindow BEGIN")
        defer { ComputerUseTrace.mark("recoverVisibleWindow END") }
        var recovered = false

        // Only unhide when the process is actually hidden. Calling unhide() on a
        // visible app can still reorder windows and produce a visible flash.
        if let runningApplication = NSRunningApplication(processIdentifier: app.pid),
           runningApplication.isHidden
        {
            let unhid = runningApplication.unhide()
            if unhid { ComputerUseTrace.mark("unhide() returned true") }
            recovered = unhid || recovered
        }

        if let window = preferredWindow ?? firstAnyWindow(for: appElement) {
            let unminimized = unminimize(window)
            if unminimized { ComputerUseTrace.mark("unminimize() returned true") }
            recovered = unminimized || recovered
        }

        if recovered {
            Thread.sleep(forTimeInterval: windowVisibilityRecoveryDelay)
        }

        return recovered
    }

    private static func waitForUsableWindow(
        appElement: AXUIElement,
        appPID: pid_t,
        focusedApplication: AXUIElement?,
        systemWide: AXUIElement
    ) -> AXUIElement? {
        let deadline = Date().addingTimeInterval(windowStartupTimeout)
        repeat {
            if let window = preferredFocusedWindow(
                appElement: appElement,
                appPID: appPID,
                focusedApplication: focusedApplication,
                systemWide: systemWide
            ) {
                return window
            }
            Thread.sleep(forTimeInterval: windowStartupPollInterval)
        } while Date() < deadline
        return nil
    }

    private static func firstWindow(for appElement: AXUIElement) -> AXUIElement? {
        guard let windows = copyArray(appElement, attribute: kAXWindowsAttribute) else {
            return nil
        }

        return windows.first(where: isUsableWindowElement(_:))
    }

    private static func firstAnyWindow(for appElement: AXUIElement) -> AXUIElement? {
        copyElement(appElement, attribute: kAXFocusedWindowAttribute)
            ?? copyArray(appElement, attribute: kAXWindowsAttribute)?.first(where: { stringValue(of: $0, attribute: kAXRoleAttribute) == kAXWindowRole as String })
    }

    private static func unminimize(_ window: AXUIElement) -> Bool {
        guard boolValue(of: window, attribute: kAXMinimizedAttribute) == true else {
            return false
        }

        return AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse) == .success
    }

    private static func preferredFocusedWindow(appElement: AXUIElement, appPID: pid_t, focusedApplication: AXUIElement?, systemWide: AXUIElement) -> AXUIElement? {
        if let focusedApplication, pid(of: focusedApplication) == appPID {
            return usableWindowElement(from: copyElement(systemWide, attribute: kAXFocusedWindowAttribute))
                ?? usableWindowElement(from: copyElement(focusedApplication, attribute: kAXFocusedWindowAttribute))
                ?? firstWindow(for: focusedApplication)
                ?? usableWindowElement(from: copyElement(appElement, attribute: kAXFocusedWindowAttribute))
                ?? firstWindow(for: appElement)
        }

        return usableWindowElement(from: copyElement(appElement, attribute: kAXFocusedWindowAttribute)) ?? firstWindow(for: appElement)
    }

    private static func usableWindowElement(from element: AXUIElement?) -> AXUIElement? {
        guard let element, isUsableWindowElement(element) else {
            return nil
        }

        return element
    }

    private static func isUsableWindowElement(_ element: AXUIElement) -> Bool {
        stringValue(of: element, attribute: kAXRoleAttribute) == kAXWindowRole as String
            && boolValue(of: element, attribute: kAXMinimizedAttribute) != true
    }

    private static func preferredFocusedElement(appElement: AXUIElement, appPID: pid_t, focusedApplication: AXUIElement?, systemWide: AXUIElement) -> AXUIElement? {
        if let focusedApplication, pid(of: focusedApplication) == appPID {
            return copyElement(systemWide, attribute: kAXFocusedUIElementAttribute)
                ?? copyElement(focusedApplication, attribute: kAXFocusedUIElementAttribute)
                ?? copyElement(appElement, attribute: kAXFocusedUIElementAttribute)
        }

        return copyElement(appElement, attribute: kAXFocusedUIElementAttribute)
    }

    private static func buildFixtureSnapshot(app: RunningAppDescriptor, state: FixtureAppState) -> AppSnapshot {
        var lines: [String] = []

        var records: [Int: ElementRecord] = [:]
        let focusedIdentifier = state.focusedIdentifier
        var focusedSummary: String?

        for element in state.elements.sorted(by: { $0.index < $1.index }) {
            let titleSegment = element.title.map { " \($0)" } ?? ""
            let valueSegment = element.value.map { " Value: \($0)" } ?? ""
            let actionsSegment = element.actions.isEmpty ? "" : " Secondary Actions: \(element.actions.joined(separator: ", "))"
            let focusSegment = focusedIdentifier == element.identifier ? " (focused)" : ""
            lines.append("\(String(repeating: "    ", count: element.index == 0 ? 0 : 1))\(element.index) \(element.role)\(titleSegment)\(focusSegment) ID: \(element.identifier)\(valueSegment)\(actionsSegment) Frame: \(element.frame.cgRect.renderedLocalFrame)")

            let record = ElementRecord(
                index: element.index,
                identifier: element.identifier,
                element: nil,
                localFrame: element.frame.cgRect,
                rawActions: element.actions,
                prettyActions: element.actions,
                role: element.role,
                title: element.title
            )
            records[element.index] = record

            if focusedIdentifier == element.identifier {
                focusedSummary = "\(element.index) \(element.role)"
            }
        }

        return AppSnapshot(
            app: app,
            windowTitle: state.windowTitle,
            windowBounds: state.windowBounds.cgRect,
            targetWindowID: nil,
            targetWindowLayer: nil,
            screenshotImageData: nil,
            mode: .fixture,
            treeLines: lines,
            focusedSummary: focusedSummary,
            focusedElement: nil,
            selectedText: nil,
            elements: records
        )
    }
}

private struct WindowCapture {
    let windowID: CGWindowID
    let layer: Int
    let bounds: CGRect
    let isOnScreen: Bool
    let image: CGImage?

    static func resolve(
        for pid: pid_t,
        titleHint: String?,
        frameHint: CGRect?,
        captureScreenshot: Bool = true
    ) -> WindowCapture? {
        // `.optionAll` also exposes hidden/minimized target windows. ScreenCaptureKit
        // can capture a desktop-independent window without bringing it to the front.
        guard let infoList = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }

        let candidates = infoList.enumerated().compactMap { offset, info -> WindowCaptureCandidate? in
            guard
                let ownerPID = info[kCGWindowOwnerPID as String] as? pid_t,
                ownerPID == pid,
                let number = info[kCGWindowNumber as String] as? NSNumber,
                let layer = info[kCGWindowLayer as String] as? Int,
                let boundsDictionary = info[kCGWindowBounds as String] as? NSDictionary,
                let bounds = CGRect(dictionaryRepresentation: boundsDictionary)
            else {
                return nil
            }

            let title = info[kCGWindowName as String] as? String
            let area = Int(bounds.width * bounds.height)
            return WindowCaptureCandidate(
                windowID: CGWindowID(number.uint32Value),
                layer: layer,
                bounds: bounds,
                title: title,
                area: area,
                frontToBackIndex: offset,
                isOnScreen: (info[kCGWindowIsOnscreen as String] as? NSNumber)?
                    .boolValue == true
            )
        }

        guard let best = preferredWindowCaptureCandidate(
            candidates,
            titleHint: titleHint,
            frameHint: frameHint
        ) else {
            return nil
        }

        let image = captureScreenshot && best.windowID != 0
            ? captureImage(windowID: best.windowID, bounds: best.bounds)
            : nil

        return WindowCapture(
            windowID: best.windowID,
            layer: best.layer,
            bounds: best.bounds,
            isOnScreen: best.isOnScreen,
            image: image
        )
    }

    private static func captureImage(windowID: CGWindowID, bounds: CGRect) -> CGImage? {
        ComputerUseTrace.mark("ScreenCaptureKit capture BEGIN (window \(windowID))")
        let image = ScreenCaptureKitWindowCapture.capture(
            windowID: windowID,
            bounds: bounds,
            timeout: screenshotCaptureTimeout
        )
        ComputerUseTrace.mark("ScreenCaptureKit capture END -> \(image == nil ? "nil (FAILED/TIMED OUT)" : "ok")")
        return image
    }

    fileprivate static func bestEffortScaleFactor(for bounds: CGRect) -> CGFloat {
        NSScreen.screens.first(where: { $0.frame.intersects(bounds) })?.backingScaleFactor
            ?? NSScreen.main?.backingScaleFactor
            ?? 1
    }

    func imageDataIfAvailable() -> Data? {
        guard let image else {
            return nil
        }

        return boundedScreenshotData(for: image)
    }
}

/// Queue label of the caller — used to tell "ran on the main queue" apart from
/// "ran on a connection queue" when diagnosing capture stalls.
func currentDispatchQueueLabel() -> String {
    String(cString: __dispatch_queue_get_label(nil))
}

final class ScreenCaptureKitWindowCapture: @unchecked Sendable {
    private let completion = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var completed = false
    private var image: CGImage?

    static func capture(
        windowID: CGWindowID,
        bounds: CGRect,
        timeout: TimeInterval,
    ) -> CGImage? {
        // [operon] Denied Screen Recording never answers — the completion simply
        // never fires. Waiting out the timeout on every call turns a permission
        // problem into "everything is slow and empty", so fail fast instead.
        guard ScreenRecordingAccess.isGranted else {
            ScreenRecordingAccess.promptOnce()
            ComputerUseTrace.mark("SCK capture skipped: screen recording not granted")
            return nil
        }
        let capture = ScreenCaptureKitWindowCapture()
        capture.start(windowID: windowID, bounds: bounds)
        guard waitForScreenCaptureCompletion(
            capture.completion,
            timeout: timeout
        ) else {
            return nil
        }
        return capture.lock.withLock { capture.image }
    }

    private func start(windowID: CGWindowID, bounds: CGRect) {
        ComputerUseTrace.mark(
            "SCK capture requested from \(currentDispatchQueueLabel()) main=\(Thread.isMainThread)"
        )
        SCShareableContent.getExcludingDesktopWindows(
            false,
            onScreenWindowsOnly: false
        ) { [weak self] content, error in
            ComputerUseTrace.mark(
                "SCShareableContent callback fired on \(currentDispatchQueueLabel()) main=\(Thread.isMainThread)"
            )
            guard let self else {
                return
            }
            // Both failure modes used to be swallowed into a bare `nil`, so a
            // capture that never fired looked identical to one that errored.
            if let error {
                ComputerUseTrace.mark("SCShareableContent error: \(error.localizedDescription)")
                // [operon] A TCC refusal is a standing condition, not a blip:
                // record it so callers stop paying a full timeout each time.
                if ScreenRecordingAccess.isUserDeclined(error) {
                    ScreenRecordingAccess.noteCaptureDenied()
                }
                self.finish(image: nil)
                return
            }
            guard let window = content?.windows.first(where: { $0.windowID == windowID }) else {
                ComputerUseTrace.mark(
                    "SCShareableContent has no window \(windowID) (enumerated \(content?.windows.count ?? -1))"
                )
                self.finish(image: nil)
                return
            }

            let configuration = SCStreamConfiguration()
            let scaleFactor = WindowCapture.bestEffortScaleFactor(for: bounds)
            let captureSize = window.frame.isEmpty ? bounds.size : window.frame.size
            configuration.width = max(1, Int(ceil(captureSize.width * scaleFactor)))
            configuration.height = max(1, Int(ceil(captureSize.height * scaleFactor)))
            configuration.showsCursor = false
            configuration.scalesToFit = false
            configuration.ignoreShadowsSingleWindow = true
            configuration.queueDepth = 1

            let filter = SCContentFilter(desktopIndependentWindow: window)
            SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: configuration
            ) { [weak self] image, error in
                if let error {
                    ComputerUseTrace.mark("SCScreenshotManager error: \(error.localizedDescription)")
                    if ScreenRecordingAccess.isUserDeclined(error) {
                        ScreenRecordingAccess.noteCaptureDenied()
                    }
                } else if image == nil {
                    ComputerUseTrace.mark("SCScreenshotManager returned nil image with no error")
                } else {
                    ScreenRecordingAccess.noteCaptureAllowed()
                }
                self?.finish(image: error == nil ? image : nil)
            }
        }
    }

    private func finish(image: CGImage?) {
        let shouldSignal = lock.withLock {
            guard !completed else {
                return false
            }
            completed = true
            self.image = image
            return true
        }
        if shouldSignal {
            completion.signal()
        }
    }
}

func waitForScreenCaptureCompletion(
    _ semaphore: DispatchSemaphore,
    timeout: TimeInterval
) -> Bool {
    guard Thread.isMainThread else {
        return semaphore.wait(timeout: .now() + timeout) == .success
    }

    let deadline = Date(timeIntervalSinceNow: timeout)
    while semaphore.wait(timeout: .now()) == .timedOut {
        guard Date() < deadline else {
            return false
        }
        RunLoop.current.run(
            mode: .default,
            before: Date(timeIntervalSinceNow: 0.01)
        )
    }
    return true
}

struct WindowCaptureCandidate {
    let windowID: CGWindowID
    let layer: Int
    let bounds: CGRect
    let title: String?
    let area: Int
    let frontToBackIndex: Int
    let isOnScreen: Bool

    init(
        windowID: CGWindowID,
        layer: Int,
        bounds: CGRect,
        title: String?,
        area: Int,
        frontToBackIndex: Int,
        isOnScreen: Bool = false
    ) {
        self.windowID = windowID
        self.layer = layer
        self.bounds = bounds
        self.title = title
        self.area = area
        self.frontToBackIndex = frontToBackIndex
        self.isOnScreen = isOnScreen
    }
}

func preferredWindowCaptureCandidate(
    _ candidates: [WindowCaptureCandidate],
    titleHint: String?,
    frameHint: CGRect? = nil
) -> WindowCaptureCandidate? {
    // Prefer normal layer-0 windows of meaningful size (original threshold).
    let usable = candidates
        .filter { $0.layer == 0 && $0.area >= 20_000 }
        .sorted { lhs, rhs in
            lhs.frontToBackIndex < rhs.frontToBackIndex
        }

    guard !usable.isEmpty else {
        return candidates
            .filter { $0.area >= 20_000 }
            .sorted { lhs, rhs in
                lhs.area > rhs.area
            }
            .first
    }

    let onScreen = usable.filter(\.isOnScreen)
    let visibilityCandidates = onScreen.isEmpty ? usable : onScreen

    let titleMatches: [WindowCaptureCandidate]
    if let titleHint, !titleHint.isEmpty {
        titleMatches = visibilityCandidates.filter { $0.title == titleHint }
    } else {
        titleMatches = []
    }

    let frameCandidates = titleMatches.isEmpty
        ? visibilityCandidates
        : titleMatches
    if let frameHint {
        return frameCandidates.min { lhs, rhs in
            windowFrameDistance(lhs.bounds, frameHint) <
                windowFrameDistance(rhs.bounds, frameHint)
        }
    }

    let visibleTitleMatches = visibilityCandidates.filter {
        $0.title == titleHint
    }

    guard let hinted = visibleTitleMatches.first else {
        return visibilityCandidates.first
    }

    guard let frontmost = visibilityCandidates.first else {
        return hinted
    }
    if frontmost.windowID != hinted.windowID,
       frontmost.bounds.intersects(hinted.bounds)
    {
        return frontmost
    }

    return hinted
}

private func windowFrameDistance(_ lhs: CGRect, _ rhs: CGRect) -> CGFloat {
    abs(lhs.minX - rhs.minX)
        + abs(lhs.minY - rhs.minY)
        + abs(lhs.width - rhs.width)
        + abs(lhs.height - rhs.height)
}

func boundedScreenshotData(
    for image: CGImage,
    maxBytes: Int = screenshotResultMaxBytes,
    maxDimension: CGFloat = screenshotResultMaxDimension,
    minScale: CGFloat = screenshotResultMinScale
) -> Data? {
    guard image.width > 0, image.height > 0, maxBytes > 0 else {
        return nil
    }

    let original = encodedData(for: image)
    let largestDimension = CGFloat(max(image.width, image.height))
    var scale = min(1, maxDimension / largestDimension)

    if scale >= 1, let original, original.count <= maxBytes {
        return original
    }

    var best = original
    while scale >= minScale {
        guard let resized = resizedCGImage(image, scale: scale),
              let data = encodedData(for: resized)
        else {
            break
        }

        best = data
        if data.count <= maxBytes {
            return data
        }

        scale *= 0.85
    }

    return best
}

/// JPEG has no alpha, so a window with rounded corners or a shadow would encode
/// its transparent pixels as black. Flatten onto white first.
private func encodedData(for image: CGImage) -> Data? {
    let source = opaqueImage(image) ?? image
    let bitmap = NSBitmapImageRep(cgImage: source)
    return bitmap.representation(
        using: .jpeg,
        properties: [.compressionFactor: screenshotJPEGCompressionQuality]
    )
}

private func opaqueImage(_ image: CGImage) -> CGImage? {
    let alpha = image.alphaInfo
    guard alpha != .none, alpha != .noneSkipFirst, alpha != .noneSkipLast else {
        return image
    }
    guard let context = CGContext(
        data: nil,
        width: image.width,
        height: image.height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    ) else {
        return nil
    }
    let rect = CGRect(x: 0, y: 0, width: image.width, height: image.height)
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(rect)
    context.draw(image, in: rect)
    return context.makeImage()
}

private func resizedCGImage(_ image: CGImage, scale: CGFloat) -> CGImage? {
    let width = max(1, Int((CGFloat(image.width) * scale).rounded()))
    let height = max(1, Int((CGFloat(image.height) * scale).rounded()))
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue

    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: bitmapInfo
    ) else {
        return nil
    }

    context.interpolationQuality = .medium
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return context.makeImage()
}

private final class AsyncResultBox<T>: @unchecked Sendable {
    var result: Result<T, Error>?
}

enum BlockingAsyncBridge {
    static func run<T>(timeout: TimeInterval? = nil, _ operation: @escaping @Sendable () async throws -> T) throws -> T {
        let semaphore = DispatchSemaphore(value: 0)
        let resultBox = AsyncResultBox<T>()

        let task = Task.detached {
            do {
                resultBox.result = .success(try await operation())
            } catch {
                resultBox.result = .failure(error)
            }

            semaphore.signal()
        }

        guard waitForSignal(semaphore, timeout: timeout) else {
            task.cancel()
            throw ComputerUseError.message("ScreenCaptureKit screenshot task timed out after \(timeout ?? 0) seconds.")
        }

        return try resultBox.result?.get() ?? {
            throw ComputerUseError.message("ScreenCaptureKit screenshot task finished without producing a result.")
        }()
    }

    private static func waitForSignal(_ semaphore: DispatchSemaphore, timeout: TimeInterval?) -> Bool {
        let deadline = timeout.map { Date(timeIntervalSinceNow: $0) }

        if Thread.isMainThread {
            while semaphore.wait(timeout: .now()) == .timedOut {
                if let deadline, Date() >= deadline {
                    return false
                }

                RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
            }
            return true
        }

        if let timeout {
            return semaphore.wait(timeout: .now() + timeout) == .success
        }

        semaphore.wait()
        return true
    }
}

private struct RenderContext {
    let windowBounds: CGRect?
    let focusedElement: AXUIElement?
    let textLimit: SnapshotTextLimit
    let treeLimits: AccessibilityTreeLimits
}

private struct TreeRenderer {
    let context: RenderContext
    var nextIndex = 0
    var lines: [String] = []
    var records: [Int: ElementRecord] = [:]
    var identifierIndex: [String: String] = [:]
    var focusedSummary: String?

    init(context: RenderContext) {
        self.context = context
    }

    mutating func render(_ root: AXUIElement, depth: Int = 0, ancestors: [AXUIElement] = []) {
        guard shouldContinueRendering(nextIndex: nextIndex, depth: depth, limits: context.treeLimits) else {
            return
        }

        guard !ancestors.contains(where: { CFEqual($0, root) }) else {
            return
        }
        let nextAncestors = ancestors + [root]

        let index = nextIndex

        let role = stringValue(of: root, attribute: kAXRoleAttribute) ?? "AXUnknown"
        let subrole = stringValue(of: root, attribute: kAXSubroleAttribute)
        let baseRoleText = roleDescription(of: root, role: role, subrole: subrole)
        let label = stringValue(of: root, attribute: kAXDescriptionAttribute)
            .map { sanitizeText($0, textLimit: context.textLimit) }
        let help = stringValue(of: root, attribute: kAXHelpAttribute)
            .map { sanitizeText($0, textLimit: context.textLimit) }
        let value = sanitizedValue(of: root, textLimit: context.textLimit)
        let axIdentifier = displayIdentifier(stringValue(of: root, attribute: kAXIdentifierAttribute))
        let traits = summarizeTraits(of: root)
        let actions = copyActions(root) ?? []
        let prettyActions = meaningfulActions(actions, role: role)
        let placeholder = placeholderValue(of: root, textLimit: context.textLimit)
        let webAreaDepth = webAreaDepth(role: role, ancestors: ancestors)
        let localFrame = resolveLocalFrame(of: root, windowBounds: context.windowBounds)
        let rowTexts = role == kAXRowRole as String ? flattenedRowTexts(of: root, textLimit: context.textLimit) : []
        let childElements = children(of: root)
        let genericTextSummary = summarizedGenericText(
            of: root,
            role: role,
            childElements: childElements,
            textLimit: context.textLimit
        )
        let summaryImageChildren = genericTextSummary == nil ? [] : summaryImageDescendants(of: root)
        let rendersSummaryAsChildren = shouldRenderGenericTextSummaryAsChildren(
            genericTextSummary,
            summaryImageCount: summaryImageChildren.count
        )
        let title = preferredDisplayTitle(
            for: root,
            role: role,
            label: label,
            identifier: axIdentifier,
            explicitValue: value,
            rowTexts: rowTexts,
            textLimit: context.textLimit
        )
        let linkText = role == "AXLink" ? markdownLinkText(for: root, title: title, label: label, value: value, textLimit: context.textLimit) : nil
        let displayTitle = linkText ?? title
        let inlineRowSummary = outlineRowSummary(for: root, role: role)
        let hidesChildren = shouldSuppressChildren(
            role: role,
            title: displayTitle,
            label: label,
            help: help,
            value: value,
            identifier: axIdentifier,
            traits: traits,
            actions: prettyActions,
            children: childElements,
            genericTextSummary: genericTextSummary
        )
        let roleText = displayRoleText(
            baseRoleText: baseRoleText,
            role: role,
            title: displayTitle,
            label: label,
            suppressChildren: hidesChildren
        )

        if shouldElideNode(
            role: role,
            title: displayTitle,
            label: label,
            value: value,
            identifier: axIdentifier,
            traits: traits,
            actions: prettyActions,
            childCount: childElements.count,
            genericTextSummary: genericTextSummary,
            webAreaDepth: webAreaDepth
        ) {
            for child in childElements {
                render(child, depth: depth, ancestors: nextAncestors)
            }
            return
        }

        nextIndex += 1

        let traitsSegment = traits.isEmpty ? "" : " (\(traits.joined(separator: ", ")))"
        let titleSegment = displayTitle.map { " \($0)" } ?? ""
        let rowSummary = inlineRowSummary ?? (rendersSummaryAsChildren ? nil : genericTextSummary)
        let rowSummarySegment = rowSummary.map { " \($0)" } ?? ""
        let labelSegment = formattedLabelSegment(label, title: displayTitle, linkText: linkText, textLimit: context.textLimit)
        let helpSegment = {
            guard let help else {
                return ""
            }
            if help == displayTitle || help == label {
                return ""
            }
            return " Help: \(help)"
        }()
        let urlSegment = formattedURLSegment(for: root, title: displayTitle, label: label, textLimit: context.textLimit)
        let identifierSegment = displayIdentifierSegment(for: root, role: role, identifier: axIdentifier, title: displayTitle)
        let rawValueSegment = formattedValueSegment(for: root, roleText: roleText, title: displayTitle, value: value)
        let valueSegment = formattedValueSegmentWithSeparator(
            rawValueSegment,
            precedingSegments: [labelSegment, helpSegment, urlSegment, identifierSegment]
        )
        let placeholderSegment = formattedPlaceholderSegment(
            placeholder,
            title: displayTitle,
            label: label,
            value: value,
            precedingSegments: [labelSegment, helpSegment, urlSegment, identifierSegment, valueSegment]
        )
        let actionsPrefix = shouldCommaSeparateActions(
            title: displayTitle,
            inlineRowSummary: inlineRowSummary,
            genericTextSummary: genericTextSummary,
            segments: [labelSegment, helpSegment, urlSegment, identifierSegment, valueSegment, placeholderSegment]
        ) ? ", Secondary Actions: " : " Secondary Actions: "
        let actionsSegment = prettyActions.isEmpty ? "" : "\(actionsPrefix)\(prettyActions.joined(separator: ", "))"
        let linePrefix = roleText.isEmpty ? "\(index)" : "\(index) \(roleText)"

        let lineBody = "\(linePrefix)\(traitsSegment)\(titleSegment)\(rowSummarySegment)\(labelSegment)\(helpSegment)\(urlSegment)\(identifierSegment)\(valueSegment)\(placeholderSegment)"
        lines.append("\(String(repeating: "\t", count: depth))\(lineBody)\(actionsSegment)")

        let record = ElementRecord(
            index: index,
            identifier: axIdentifier,
            element: root,
            localFrame: localFrame,
            rawActions: actions,
            prettyActions: prettyActions,
            role: role,
            title: displayTitle
        )
        records[index] = record

        if let axIdentifier, let localFrame {
            identifierIndex[axIdentifier] = "\(axIdentifier) -> \(index) @ \(localFrame.renderedLocalFrame)"
        }

        if let focusedElement = context.focusedElement, CFEqual(focusedElement, root) {
            focusedSummary = lineBody
        }

        if role == kAXRowRole as String, boolValue(of: root, attribute: kAXSelectedAttribute) != true {
            for text in Array(rowTexts.dropFirst()) {
                lines.append(text)
            }
            return
        }

        if rendersSummaryAsChildren, let genericTextSummary {
            renderSyntheticText(genericTextSummary, representedBy: root, depth: depth + 1)
            for image in summaryImageChildren {
                render(image, depth: depth + 1, ancestors: nextAncestors)
            }
            return
        }

        if hidesChildren {
            return
        }

        for child in childElements {
            render(child, depth: depth + 1, ancestors: nextAncestors)
        }
    }

    private mutating func renderSyntheticText(_ text: String, representedBy element: AXUIElement, depth: Int) {
        guard shouldContinueRendering(nextIndex: nextIndex, depth: depth, limits: context.treeLimits) else {
            return
        }

        let index = nextIndex
        nextIndex += 1
        lines.append("\(String(repeating: "\t", count: depth))\(index) text \(text)")

        records[index] = ElementRecord(
            index: index,
            identifier: nil,
            element: element,
            localFrame: resolveLocalFrame(of: element, windowBounds: context.windowBounds),
            rawActions: [],
            prettyActions: [],
            isSyntheticText: true,
            role: kAXStaticTextRole as String,
            title: text
        )
    }

    private func opaqueIdentifier(for element: AXUIElement) -> String {
        String(CFHash(element))
    }

    private func webAreaDepth(role: String, ancestors: [AXUIElement]) -> Int? {
        if role == axWebAreaRole {
            return 0
        }

        guard let webAreaIndex = ancestors.firstIndex(where: { ancestor in
            stringValue(of: ancestor, attribute: kAXRoleAttribute) == axWebAreaRole
        }) else {
            return nil
        }

        return ancestors.count - webAreaIndex
    }

    private func children(of element: AXUIElement) -> [AXUIElement] {
        let role = stringValue(of: element, attribute: kAXRoleAttribute)
        let rows = copyArray(element, attribute: kAXRowsAttribute) ?? []
        let visibleChildren = copyArray(element, attribute: axVisibleChildrenAttribute) ?? []
        let attributes = childTraversalAttributes(
            role: role,
            hasRows: !rows.isEmpty,
            hasVisibleChildren: !visibleChildren.isEmpty
        )
        var children: [AXUIElement] = []

        for attribute in attributes {
            let sourceValues: [AXUIElement]
            if attribute == kAXRowsAttribute {
                sourceValues = rows
            } else if attribute == axVisibleChildrenAttribute {
                sourceValues = visibleChildren
            } else {
                sourceValues = copyArray(element, attribute: attribute) ?? []
            }

            let values = attribute == kAXRowsAttribute ? visibleRows(in: sourceValues, parent: element) : sourceValues

            for child in values {
                if shouldSkipChild(child, of: element) {
                    continue
                }

                if !children.contains(where: { CFEqual($0, child) }) {
                    children.append(child)
                }
            }
        }

        return children
    }
}

func childTraversalAttributes(role: String?, hasRows: Bool, hasVisibleChildren: Bool) -> [String] {
    var attributes: [String] = []
    if !(hasRows && usesRowsAsPrimaryRole(role)) && !(hasVisibleChildren && usesVisibleChildrenAsPrimaryRole(role)) {
        attributes.append(kAXChildrenAttribute)
    }
    attributes.append(kAXRowsAttribute)
    attributes.append(axContentsAttribute)
    attributes.append(axVisibleChildrenAttribute)
    return attributes
}

private func usesRowsAsPrimaryRole(_ role: String?) -> Bool {
    return [
        kAXOutlineRole as String,
        kAXListRole as String,
        kAXTableRole as String,
        "AXBrowser",
    ].contains(role)
}

private func usesVisibleChildrenAsPrimaryRole(_ role: String?) -> Bool {
    role == kAXListRole as String
}

private func shouldSkipChild(_ child: AXUIElement, of parent: AXUIElement) -> Bool {
    let parentRole = stringValue(of: parent, attribute: kAXRoleAttribute)
    guard parentRole == kAXMenuBarRole as String else {
        return false
    }

    return stringValue(of: child, attribute: kAXTitleAttribute) == "Apple"
}

func shouldContinueRendering(
    nextIndex: Int,
    depth: Int,
    limits: AccessibilityTreeLimits = .defaults
) -> Bool {
    nextIndex < limits.maxNodeCount && depth < limits.maxDepth
}

private func summarizeTraits(of element: AXUIElement) -> [String] {
    var values: [String] = []

    if boolValue(of: element, attribute: kAXSelectedAttribute) == true {
        values.append("selected")
    }

    if boolValue(of: element, attribute: kAXExpandedAttribute) == true {
        values.append("expanded")
    }

    if boolValue(of: element, attribute: kAXEnabledAttribute) == false {
        values.append("disabled")
    }

    if isSettable(of: element, attribute: kAXValueAttribute) {
        values.append("settable")
    }

    if let valueType = valueTypeTrait(of: element) {
        values.append(valueType)
    }

    return values
}

private func valueTypeTrait(of element: AXUIElement) -> String? {
    guard isSettable(of: element, attribute: kAXValueAttribute) else {
        return nil
    }

    guard let value = attributeValue(of: element, attribute: kAXValueAttribute) else {
        return nil
    }

    if CFGetTypeID(value) == CFStringGetTypeID() {
        return "string"
    }

    if value is NSNumber {
        if numericValueRepresentsBoolean(for: element, value: value) {
            return "boolean"
        }

        return "float"
    }

    return nil
}

private func copyElement(_ element: AXUIElement, attribute: String) -> AXUIElement? {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    guard error == .success, let value else {
        return nil
    }

    return (value as! AXUIElement)
}

private func copyArray(_ element: AXUIElement, attribute: String) -> [AXUIElement]? {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    guard error == .success, let value else {
        return nil
    }

    return value as? [AXUIElement]
}

private func copyActions(_ element: AXUIElement) -> [String]? {
    var actions: CFArray?
    let error = AXUIElementCopyActionNames(element, &actions)
    guard error == .success else {
        return nil
    }

    return actions as? [String]
}

private func attributeValue(of element: AXUIElement, attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    guard error == .success else {
        return nil
    }

    return value
}

private func stringValue(of element: AXUIElement, attribute: String) -> String? {
    guard let value = attributeValue(of: element, attribute: attribute) else {
        return nil
    }

    if CFGetTypeID(value) == CFStringGetTypeID() {
        guard let string = value as? String else {
            return nil
        }

        return string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : string
    }

    return nil
}

private func copySelectedText(_ element: AXUIElement, textLimit: SnapshotTextLimit = .defaults) -> String? {
    guard let value = stringValue(of: element, attribute: kAXSelectedTextAttribute) else {
        return nil
    }

    let sanitized = sanitizeText(value, textLimit: textLimit)
    return sanitized.isEmpty ? nil : sanitized
}

private func boolValue(of element: AXUIElement, attribute: String) -> Bool? {
    guard let value = attributeValue(of: element, attribute: attribute) else {
        return nil
    }

    return value as? Bool
}

private func pid(of element: AXUIElement) -> pid_t {
    var processIdentifier: pid_t = 0
    AXUIElementGetPid(element, &processIdentifier)
    return processIdentifier
}

private func isSettable(of element: AXUIElement, attribute: String) -> Bool {
    var settable = DarwinBoolean(false)
    let error = AXUIElementIsAttributeSettable(element, attribute as CFString, &settable)
    return error == .success && settable.boolValue
}

private func sanitizedValue(of element: AXUIElement, textLimit: SnapshotTextLimit = .defaults) -> String? {
    if let string = stringValue(of: element, attribute: kAXValueAttribute) {
        let sanitized = sanitizeText(string, textLimit: textLimit)
        return sanitized.isEmpty ? nil : sanitized
    }

    guard let value = attributeValue(of: element, attribute: kAXValueAttribute) else {
        return nil
    }

    if let number = value as? NSNumber {
        if numericValueRepresentsBoolean(for: element, value: value) {
            return number.boolValue ? "on" : "off"
        }

        return number.stringValue
    }

    return nil
}

private func placeholderValue(of element: AXUIElement, textLimit: SnapshotTextLimit = .defaults) -> String? {
    for attribute in ["AXPlaceholderValue", "AXPlaceholder"] {
        if let string = stringValue(of: element, attribute: attribute) {
            let sanitized = sanitizeText(string, textLimit: textLimit)
            if !sanitized.isEmpty {
                return sanitized
            }
        }
    }

    return nil
}

private func numericValueRepresentsBoolean(for element: AXUIElement, value: CFTypeRef) -> Bool {
    guard let number = value as? NSNumber else {
        return false
    }

    guard number == 0 || number == 1 else {
        return false
    }

    let role = stringValue(of: element, attribute: kAXRoleAttribute) ?? ""
    let roleText = roleDescription(
        of: element,
        role: role,
        subrole: stringValue(of: element, attribute: kAXSubroleAttribute)
    )

    return roleText == "tab"
        || role == kAXCheckBoxRole as String
        || role == kAXRadioButtonRole as String
}

private func preferredDisplayTitle(
    for element: AXUIElement,
    role: String,
    label: String?,
    identifier: String?,
    explicitValue: String?,
    rowTexts: [String],
    textLimit: SnapshotTextLimit = .defaults
) -> String? {
    if let title = stringValue(of: element, attribute: kAXTitleAttribute), !title.isEmpty {
        return sanitizeText(title, textLimit: textLimit)
    }

    if role == kAXRowRole as String {
        return rowTexts.first
    }

    if (role == kAXOutlineRole as String || role == kAXListRole as String), let identifier {
        return identifier
    }

    if (role == kAXButtonRole as String || role == kAXPopUpButtonRole as String), let label, !label.isEmpty {
        return sanitizeText(label, textLimit: textLimit)
    }

    if role == kAXImageRole as String, let label, !label.isEmpty {
        return sanitizeText(label, textLimit: textLimit)
    }

    if (role == kAXGroupRole as String || role == kAXUnknownRole as String || role == "AXWebArea"),
       let label,
       !label.isEmpty
    {
        return sanitizeText(label, textLimit: textLimit)
    }

    guard roleDescription(of: element, role: role, subrole: stringValue(of: element, attribute: kAXSubroleAttribute)) == "search text field" else {
        return nil
    }

    return explicitValue
}

private func markdownLinkText(
    for element: AXUIElement,
    title: String?,
    label: String?,
    value: String?,
    textLimit: SnapshotTextLimit = .defaults
) -> String? {
    guard let url = urlValue(of: element, attribute: kAXURLAttribute, textLimit: textLimit), !url.isEmpty else {
        return nil
    }

    let text = [label, title, value]
        .compactMap { candidate -> String? in
            guard let candidate else {
                return nil
            }
            let sanitized = sanitizeText(candidate, textLimit: textLimit)
            return sanitized.isEmpty ? nil : sanitized
        }
        .first

    guard let text else {
        return nil
    }

    return "[\(markdownEscapedLinkText(text))](\(url))"
}

private func markdownEscapedLinkText(_ text: String) -> String {
    text
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "[", with: "\\[")
        .replacingOccurrences(of: "]", with: "\\]")
}

private func outlineRowSummary(for element: AXUIElement, role: String) -> String? {
    guard role == kAXOutlineRole as String || role == kAXListRole as String else {
        return nil
    }

    guard let allRows = copyArray(element, attribute: kAXRowsAttribute), !allRows.isEmpty else {
        return nil
    }

    let visibleRows = visibleRows(in: allRows, parent: element)
    guard !visibleRows.isEmpty, visibleRows.count < allRows.count else {
        return nil
    }

    return "(showing 0-\(visibleRows.count - 1) of \(allRows.count) items)"
}

private func formattedValueSegment(for element: AXUIElement, roleText: String, title: String?, value: String?) -> String {
    guard let value, !value.isEmpty else {
        return ""
    }

    if roleText == "search text field", title == value {
        return ""
    }

    if title == nil, let role = stringValue(of: element, attribute: kAXRoleAttribute), role == kAXStaticTextRole as String {
        return " \(value)"
    }

    if ["scroll bar", "value indicator"].contains(roleText) {
        return " \(value)"
    }

    if roleText == "text entry area" {
        return " \(value)"
    }

    return " Value: \(value)"
}

func formattedLabelSegment(
    _ label: String?,
    title: String?,
    linkText: String?,
    textLimit: SnapshotTextLimit = .defaults
) -> String {
    guard let label, label != title else {
        return ""
    }

    let sanitizedLabel = sanitizeText(label, textLimit: textLimit)
    guard !sanitizedLabel.isEmpty, sanitizedLabel != title else {
        return ""
    }

    let comparableLabel = markdownEscapedLinkText(sanitizedLabel)
    if let linkText, linkText.hasPrefix("[\(comparableLabel)](") {
        return ""
    }

    return " Description: \(sanitizedLabel)"
}

private func formattedValueSegmentWithSeparator(_ valueSegment: String, precedingSegments: [String]) -> String {
    guard valueSegment.hasPrefix(" Value:"), precedingSegments.contains(where: { !$0.isEmpty }) else {
        return valueSegment
    }

    return ",\(valueSegment)"
}

func formattedPlaceholderSegment(_ placeholder: String?, title: String?, label: String?, value: String?, precedingSegments: [String]) -> String {
    guard let placeholder, !placeholder.isEmpty else {
        return ""
    }

    if placeholder == title || placeholder == label || placeholder == value {
        return ""
    }

    let prefix = precedingSegments.contains(where: { !$0.isEmpty }) || title != nil ? ", Placeholder: " : " Placeholder: "
    return "\(prefix)\(placeholder)"
}

private func shouldCommaSeparateActions(
    title: String?,
    inlineRowSummary: String?,
    genericTextSummary: String?,
    segments: [String]
) -> Bool {
    title != nil
        || inlineRowSummary != nil
        || genericTextSummary != nil
        || segments.contains(where: { !$0.isEmpty })
}

private func formattedURLSegment(
    for element: AXUIElement,
    title: String?,
    label: String?,
    textLimit: SnapshotTextLimit = .defaults
) -> String {
    guard stringValue(of: element, attribute: kAXRoleAttribute) == "AXWebArea" else {
        return ""
    }

    guard let url = urlValue(of: element, attribute: kAXURLAttribute, textLimit: textLimit), !url.isEmpty else {
        return ""
    }

    if url == title || url == label {
        return ""
    }

    return ", URL: \(url)"
}

private func urlValue(
    of element: AXUIElement,
    attribute: String,
    textLimit: SnapshotTextLimit = .defaults
) -> String? {
    guard let value = attributeValue(of: element, attribute: attribute) else {
        return nil
    }

    if CFGetTypeID(value) == CFStringGetTypeID(), let string = value as? String {
        let sanitized = sanitizeText(string, textLimit: textLimit)
        return sanitized.isEmpty ? nil : sanitized
    }

    if CFGetTypeID(value) == CFURLGetTypeID(), let url = value as? URL {
        let sanitized = sanitizeText(url.absoluteString, textLimit: textLimit)
        return sanitized.isEmpty ? nil : sanitized
    }

    return nil
}

private func displayIdentifierSegment(for element: AXUIElement, role: String, identifier: String?, title: String?) -> String {
    guard let identifier else {
        return ""
    }

    if (role == kAXOutlineRole as String || role == kAXListRole as String), title == identifier {
        return ""
    }

    return " ID: \(identifier)"
}

private func resolveLocalFrame(of element: AXUIElement, windowBounds: CGRect?) -> CGRect? {
    guard let frame = globalFrame(of: element) else {
        return nil
    }

    guard let windowBounds else {
        return frame
    }

    return windowRelativeFrame(elementFrame: frame, windowBounds: windowBounds)
}

private func globalFrame(of element: AXUIElement) -> CGRect? {
    var positionValue: CFTypeRef?
    var sizeValue: CFTypeRef?
    let positionError = AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue)
    let sizeError = AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue)
    guard
        positionError == .success,
        sizeError == .success,
        let positionValue,
        let sizeValue
    else {
        return nil
    }

    let positionAXValue = positionValue as! AXValue
    let sizeAXValue = sizeValue as! AXValue
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionAXValue, .cgPoint, &position), AXValueGetValue(sizeAXValue, .cgSize, &size) else {
        return nil
    }

    let frame = CGRect(origin: position, size: size)
    return frame
}

func shouldElideNode(
    role: String,
    title: String?,
    label: String?,
    value: String?,
    identifier: String?,
    traits: [String],
    actions: [String],
    childCount: Int,
    genericTextSummary: String? = nil,
    webAreaDepth: Int? = nil
) -> Bool {
    let genericRoles = [kAXGroupRole as String, kAXUnknownRole as String]
    guard genericRoles.contains(role) else {
        return false
    }

    if genericTextSummary != nil {
        return false
    }

    if shouldPreserveWebAreaGenericContainer(childCount: childCount, webAreaDepth: webAreaDepth) {
        return false
    }

    if childCount == 1,
       title == nil,
       label == nil,
       value == nil,
       identifier == nil,
       actions.isEmpty,
       traitsAreNonDescriptiveWrapperTraits(traits)
    {
        return true
    }

    return title == nil
        && label == nil
        && value == nil
        && identifier == nil
        && traits.isEmpty
        && actions.isEmpty
}

func shouldPreserveWebAreaGenericContainer(childCount: Int, webAreaDepth: Int?) -> Bool {
    guard childCount > 0, webAreaDepth != nil else {
        return false
    }

    return childCount > 1
}

private func traitsAreNonDescriptiveWrapperTraits(_ traits: [String]) -> Bool {
    traits.isEmpty || traits == ["settable", "string"]
}

private func shouldSuppressChildren(
    role: String,
    title: String?,
    label: String?,
    help: String?,
    value: String?,
    identifier: String?,
    traits: [String],
    actions: [String],
    children: [AXUIElement],
    genericTextSummary: String?
) -> Bool {
    if role == kAXMenuBarItemRole as String {
        return true
    }

    if role == "AXLink", title?.hasPrefix("[") == true {
        return true
    }

    return genericTextSummary != nil
}

private func summarizedGenericText(
    of element: AXUIElement,
    role: String,
    childElements: [AXUIElement],
    textLimit: SnapshotTextLimit = .defaults
) -> String? {
    guard role == kAXGroupRole as String || role == kAXUnknownRole as String else {
        return nil
    }

    guard !childElements.isEmpty else {
        return nil
    }

    guard isPlainGenericTextContainer(element, children: childElements) else {
        return nil
    }

    let texts = descendantTextsForSummary(of: element, textLimit: textLimit)
    guard texts.count >= 2 else {
        return nil
    }

    guard shouldMergeTextOnlySiblings(texts) else {
        return nil
    }

    let joined = sanitizeText(texts.joined(separator: " "), textLimit: textLimit)
        .replacingOccurrences(of: " : ", with: " :  ")
    return joined.isEmpty ? nil : joined
}

private func summaryImageDescendants(of element: AXUIElement, depth: Int = 0) -> [AXUIElement] {
    guard depth < 4 else {
        return []
    }

    let children = copyArray(element, attribute: kAXChildrenAttribute) ?? []
    var images: [AXUIElement] = []

    for child in children {
        let role = stringValue(of: child, attribute: kAXRoleAttribute) ?? ""
        if role == kAXImageRole as String {
            if !images.contains(where: { CFEqual($0, child) }) {
                images.append(child)
            }
        } else {
            for image in summaryImageDescendants(of: child, depth: depth + 1) {
                if !images.contains(where: { CFEqual($0, image) }) {
                    images.append(image)
                }
            }
        }

        if images.count >= 4 {
            return Array(images.prefix(4))
        }
    }

    return images
}

func shouldRenderGenericTextSummaryAsChildren(_ genericTextSummary: String?, summaryImageCount: Int) -> Bool {
    genericTextSummary != nil && summaryImageCount > 0
}

func shouldMergeTextOnlySiblings(_ texts: [String]) -> Bool {
    if texts.contains("日期") && texts.contains("时间") {
        return false
    }

    if texts.contains(where: isSiblingCounterText(_:)) {
        return false
    }

    if texts.contains(where: isStandaloneTimeRangeText(_:)) {
        return false
    }

    let totalLength = texts.reduce(0) { $0 + $1.count }
    return texts.count <= 8 && totalLength <= 220
}

private func isSiblingCounterText(_ text: String) -> Bool {
    text.range(of: #"^\d+\s*/\s*\d+$"#, options: .regularExpression) != nil
}

private func isStandaloneTimeRangeText(_ text: String) -> Bool {
    text.range(of: #"^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$"#, options: .regularExpression) != nil
}

private func isPlainGenericTextContainer(_ element: AXUIElement, children: [AXUIElement], depth: Int = 0) -> Bool {
    for child in children {
        let childRole = stringValue(of: child, attribute: kAXRoleAttribute) ?? ""

        if childRole == kAXStaticTextRole as String || childRole == kAXImageRole as String {
            continue
        }

        if childRole == "AXLink", summaryTextForLink(child) != nil {
            continue
        }

        if childRole == kAXGroupRole as String || childRole == kAXUnknownRole as String {
            guard depth < 3 else {
                return false
            }

            if isPlainGenericTextContainer(child, children: copyArray(child, attribute: kAXChildrenAttribute) ?? [], depth: depth + 1) {
                continue
            }
        }

        return false
    }

    return true
}

func displayRoleText(
    baseRoleText: String,
    role: String,
    title: String?,
    label: String?,
    suppressChildren: Bool
) -> String {
    if role == kAXMenuBarItemRole as String {
        return ""
    }

    if role == "AXLink" {
        return baseRoleText
    }

    if suppressChildren {
        return "container"
    }

    if baseRoleText == "radio group", role == kAXRadioGroupRole as String, title == nil, label != nil {
        return ""
    }

    return baseRoleText
}

func windowRelativeFrame(elementFrame: CGRect, windowBounds: CGRect) -> CGRect {
    CGRect(
        x: elementFrame.minX - windowBounds.minX,
        y: elementFrame.minY - windowBounds.minY,
        width: elementFrame.width,
        height: elementFrame.height
    )
}

private func roleDescription(of element: AXUIElement, role: String, subrole: String?) -> String {
    if role == kAXRowRole as String {
        return "row"
    }

    if role == kAXGroupRole as String {
        return "container"
    }

    if role == kAXMenuBarItemRole as String {
        return ""
    }

    if role == "AXLink" {
        return "link"
    }

    if role == "AXWebArea" {
        return stringValue(of: element, attribute: kAXRoleDescriptionAttribute) ?? "HTML 内容"
    }

    if let roleDescription = stringValue(of: element, attribute: kAXRoleDescriptionAttribute), !roleDescription.isEmpty {
        return roleDescription.lowercased()
    }

    if let subrole, subrole == kAXStandardWindowSubrole as String {
        return "standard window"
    }

    return humanizeAXToken(role)
}

func meaningfulActions(_ values: [String], role: String) -> [String] {
    values
        .filter {
            var ignored = [
                kAXPressAction as String,
                "AXShowDefaultUI",
                "AXShowAlternateUI",
                "AXShowMenu",
                "AXConfirm",
                "AXScrollToVisible",
            ]

            if [
                kAXMenuBarRole as String,
                kAXMenuBarItemRole as String,
                kAXMenuRole as String,
                kAXMenuItemRole as String,
            ].contains(role) {
                ignored.append(contentsOf: ["AXCancel", "AXPick"])
            }

            return !ignored.contains($0)
        }
        .filter {
            guard role == kAXScrollAreaRole as String else {
                return true
            }

            if values.contains("AXScrollUpByPage") || values.contains("AXScrollDownByPage") {
                return $0 != "AXScrollLeftByPage" && $0 != "AXScrollRightByPage"
            }

            return true
        }
        .map(prettyActionName(_:))
}

private func prettyActionName(_ value: String) -> String {
    if value == "AXZoomWindow" {
        return "zoom the window"
    }

    let stripped = value.hasPrefix("AX") ? String(value.dropFirst(2)) : value
    let withoutPage = stripped.replacingOccurrences(of: "ByPage", with: "")
    return splitCamelCase(withoutPage)
}

private func humanizeAXToken(_ value: String) -> String {
    let stripped = value.hasPrefix("AX") ? String(value.dropFirst(2)) : value
    return splitCamelCase(stripped).lowercased()
}

private func splitCamelCase(_ value: String) -> String {
    var result = ""
    for character in value {
        if character.isUppercase, !result.isEmpty {
            result.append(" ")
        }
        result.append(character)
    }
    return result
}

func sanitizeText(_ value: String, textLimit: SnapshotTextLimit = .defaults) -> String {
    let collapsed = value
        .replacingOccurrences(of: "\n", with: "\\n")
        .trimmingCharacters(in: .whitespacesAndNewlines)

    if let maxCount = textLimit.maxCount, collapsed.count > maxCount {
        return String(collapsed.prefix(maxCount)) + "..."
    }

    return collapsed
}

private func flattenedRowTexts(
    of element: AXUIElement,
    textLimit: SnapshotTextLimit = .defaults
) -> [String] {
    let cells = copyArray(element, attribute: kAXChildrenAttribute) ?? []
    let texts = cells
        .flatMap { descendantTexts(of: $0, textLimit: textLimit) }
        .map { sanitizeText($0, textLimit: textLimit) }
        .filter { !$0.isEmpty }

    var unique: [String] = []
    var seen: Set<String> = []
    for text in texts {
        if seen.insert(text).inserted {
            unique.append(text)
        }
    }

    return unique
}

private func descendantTexts(
    of element: AXUIElement,
    depth: Int = 0,
    textLimit: SnapshotTextLimit = .defaults
) -> [String] {
    guard depth < 4 else {
        return []
    }

    var values: [String] = []
    let role = stringValue(of: element, attribute: kAXRoleAttribute) ?? ""
    if role == kAXStaticTextRole as String || role == kAXTextFieldRole as String {
        if let value = sanitizedValue(of: element, textLimit: textLimit) {
            values.append(value)
        } else if let title = stringValue(of: element, attribute: kAXTitleAttribute) {
            values.append(sanitizeText(title, textLimit: textLimit))
        }
    }

    for child in copyArray(element, attribute: kAXChildrenAttribute) ?? [] {
        values.append(contentsOf: descendantTexts(of: child, depth: depth + 1, textLimit: textLimit))
    }

    return values
}

private func descendantTextsForSummary(
    of element: AXUIElement,
    depth: Int = 0,
    textLimit: SnapshotTextLimit = .defaults
) -> [String] {
    guard depth < 8 else {
        return []
    }

    let role = stringValue(of: element, attribute: kAXRoleAttribute) ?? ""
    if role == "AXLink", let linkText = summaryTextForLink(element, textLimit: textLimit) {
        return [linkText]
    }

    if role == kAXStaticTextRole as String || role == kAXTextFieldRole as String {
        if let value = sanitizedValue(of: element, textLimit: textLimit), !value.isEmpty {
            return [value]
        }

        if let title = stringValue(of: element, attribute: kAXTitleAttribute) {
            let sanitized = sanitizeText(title, textLimit: textLimit)
            return sanitized.isEmpty ? [] : [sanitized]
        }
    }

    return (copyArray(element, attribute: kAXChildrenAttribute) ?? [])
        .flatMap { descendantTextsForSummary(of: $0, depth: depth + 1, textLimit: textLimit) }
}

private func summaryTextForLink(
    _ element: AXUIElement,
    textLimit: SnapshotTextLimit = .defaults
) -> String? {
    guard let url = urlValue(of: element, attribute: kAXURLAttribute, textLimit: textLimit), !url.isEmpty else {
        return nil
    }

    let childText = (copyArray(element, attribute: kAXChildrenAttribute) ?? [])
        .flatMap { descendantTextsForSummary(of: $0, textLimit: textLimit) }
        .joined(separator: " ")
    let sanitized = sanitizeText(childText, textLimit: textLimit)
    guard !sanitized.isEmpty else {
        return nil
    }

    return summaryMarkdownLinkText(text: sanitized, url: url)
}

func summaryMarkdownLinkText(text: String, url: String) -> String {
    "[\(markdownEscapedLinkText(text))](\(url))"
}

private func visibleRows(in rows: [AXUIElement], parent: AXUIElement) -> [AXUIElement] {
    guard let parentFrame = resolveLocalFrame(of: parent, windowBounds: nil) else {
        return Array(rows.prefix(20))
    }

    let visible = rows.filter { row in
        guard let rowFrame = resolveLocalFrame(of: row, windowBounds: nil) else {
            return false
        }

        return rowFrame.intersects(parentFrame)
    }

    if visible.isEmpty {
        return Array(rows.prefix(20))
    }

    return Array(visible.prefix(20))
}

private func displayIdentifier(_ value: String?) -> String? {
    guard let value, !value.isEmpty, !value.hasPrefix("_NS:") else {
        return nil
    }

    return value
}

private func displayWindowTitle(_ value: String?, appName: String) -> String {
    guard let value, !value.isEmpty else {
        return appName
    }

    if value.hasPrefix("\(appName) –") {
        return appName
    }

    return value
}

private func quoted(_ value: String) -> String {
    "\"\(value)\""
}

private extension CGRect {
    var renderedLocalFrame: String {
        "x=\(Int(origin.x)), y=\(Int(origin.y)), w=\(Int(width)), h=\(Int(height))"
    }
}
