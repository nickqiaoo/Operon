import AppKit
import ApplicationServices
import Foundation

struct AccessibilityEnablementState: Equatable {
    let manualAccessibilityEnabled: Bool
    let enhancedUserInterfaceEnabled: Bool

    var needsWebAccessibilitySettle: Bool {
        manualAccessibilityEnabled
    }
}

func shouldSettleWebAccessibility(
    enablement: AccessibilityEnablementState
) -> Bool {
    enablement.needsWebAccessibilitySettle
}

private let applicationInvalidationNotifications = [
    "AXWindowCreated",
    "AXFocusedWindowChanged",
    "AXMainWindowChanged",
    "AXApplicationActivated",
    "AXApplicationDeactivated",
]

private let windowInvalidationNotifications = [
    "AXUIElementDestroyed",
    "AXLayoutChanged",
    "AXMoved",
    "AXResized",
    "AXTitleChanged",
]

let syntheticApplicationActivatedEventSubtype: Int16 = 1
let syntheticApplicationDeactivatedEventSubtype: Int16 = 2
let syntheticProcessNotificationEventTypeRawValue: UInt = 0x15
let syntheticWindowKeyFocusReturnedSubtype = Int16(bitPattern: 0x8000)

private let accessibilitySessionObserverCallback: AXObserverCallback = {
    _, _, _, context in
    guard let context else {
        return
    }

    let session = Unmanaged<AccessibilitySession>
        .fromOpaque(context)
        .takeUnretainedValue()
    session.markInvalidated()
}

/// Long-lived accessibility state for one running application.
///
/// Chromium and Electron can expose a sparse tree when the accessibility
/// attributes are set only immediately before a traversal. Keeping the
/// application element, enablement state and invalidation observer alive makes
/// snapshots refetchable without activating the target application.
final class AccessibilitySession: @unchecked Sendable {
    let pid: pid_t
    let appElement: AXUIElement
    let systemWideElement: AXUIElement

    private let lock = NSLock()
    private var invalidationGeneration: UInt64 = 0
    private var observer: AXObserver?
    private var observedWindow: AXUIElement?
    private var syntheticActivationAsserted = false
    private var enablementState = AccessibilityEnablementState(
        manualAccessibilityEnabled: false,
        enhancedUserInterfaceEnabled: false
    )

    init(app: RunningAppDescriptor) {
        pid = app.pid
        appElement = AXUIElementCreateApplication(app.pid)
        systemWideElement = AXUIElementCreateSystemWide()
        enablementState = enableAccessibility()
        startObservingApplication()
    }

    deinit {
        // Clear any process-local activation this session asserted for Electron
        // tree hydration. The service-level SyntheticAppFocusEnforcer owns the
        // longer-lived belief; this only undoes session-scoped notify*.
        _ = notifyAppDeactivated()
        if let observer {
            CFRunLoopRemoveSource(
                CFRunLoopGetMain(),
                AXObserverGetRunLoopSource(observer),
                .commonModes
            )
        }
    }

    var generation: UInt64 {
        lock.withLock {
            invalidationGeneration
        }
    }

    @discardableResult
    func refreshAccessibilityEnablement() -> AccessibilityEnablementState {
        let state = enableAccessibility()
        lock.withLock {
            enablementState = state
        }
        return state
    }

    var currentEnablementState: AccessibilityEnablementState {
        lock.withLock {
            enablementState
        }
    }

    func observe(window: AXUIElement) {
        guard let observer else {
            return
        }

        let previousWindow = lock.withLock { () -> AXUIElement? in
            if let observedWindow, CFEqual(observedWindow, window) {
                return nil
            }
            let previous = observedWindow
            observedWindow = window
            invalidationGeneration &+= 1
            return previous
        }

        if let previousWindow {
            removeNotifications(
                windowInvalidationNotifications,
                from: previousWindow,
                observer: observer
            )
        }
        addNotifications(
            windowInvalidationNotifications,
            to: window,
            observer: observer
        )
    }

    func markInvalidated() {
        lock.withLock {
            invalidationGeneration &+= 1
        }
    }

    /// Gives the target an AX-level main/focused window without using
    /// `NSRunningApplication.activate` or `AXRaise`.
    ///
    /// Some Electron applications hydrate their web accessibility tree only
    /// after these internal focus attributes have been asserted. System front
    /// process ownership is handled by `SyntheticAppFocusEnforcer` at the
    /// service layer, not by stealing and restoring the real foreground.
    @discardableResult
    func enforceInternalFocus(window: AXUIElement) -> Bool {
        var changed = false
        // Process-local focus only. Do NOT set AXMain — on Electron/AppKit that
        // can reorder the real window stack and produce the visible flash.
        changed = setAttributeIfSettable(
            kAXFocusedWindowAttribute as String,
            value: window,
            on: appElement
        ) || changed
        changed = setAttributeIfSettable(
            kAXFocusedAttribute as String,
            value: kCFBooleanTrue,
            on: window
        ) || changed
        return changed
    }

    @discardableResult
    func enforceInternalFocusOnObservedWindow() -> Bool {
        let window = lock.withLock {
            observedWindow
        }
        guard let window else {
            return false
        }
        return enforceInternalFocus(window: window)
    }

    /// Recovers an AX window by binding a WindowServer window to the AX tree.
    ///
    /// Electron applications can keep a real, capturable CGWindow while
    /// returning an empty `AXWindows` array in the background. Hit-testing the
    /// known window and walking its parents avoids activating the application.
    func recoverWindowFromCGWindow() -> AXUIElement? {
        guard let candidate = preferredCGWindowCandidate() else {
            return nil
        }

        let horizontalInset = min(max(candidate.bounds.width * 0.12, 24), 96)
        let verticalInset = min(max(candidate.bounds.height * 0.12, 24), 96)
        let hitTestPoints = [
            CGPoint(x: candidate.bounds.midX, y: candidate.bounds.midY),
            CGPoint(
                x: candidate.bounds.minX + horizontalInset,
                y: candidate.bounds.minY + verticalInset
            ),
            CGPoint(
                x: candidate.bounds.maxX - horizontalInset,
                y: candidate.bounds.minY + verticalInset
            ),
        ]

        for point in hitTestPoints {
            var hitElement: AXUIElement?
            guard AXUIElementCopyElementAtPosition(
                appElement,
                Float(point.x),
                Float(point.y),
                &hitElement
            ) == .success,
            let hitElement,
            let window = containingWindow(of: hitElement)
            else {
                continue
            }

            observe(window: window)
            return window
        }

        return nil
    }

    /// Sends the process-scoped activation notification used by AppKit without
    /// changing the workspace's frontmost application.
    ///
    /// This mirrors the narrow part of Codex's synthetic focus enforcer needed
    /// to make a background Electron process publish its AX window. The event
    /// is posted only to the target PID; it is not posted to the global event
    /// stream.
    ///
    /// Once asserted for this session, further calls are no-ops — re-posting
    /// activation every get_app_state is what made Electron windows visually
    /// flash on every read.
    @discardableResult
    func notifyAppActivatedWithoutWindow() -> Bool {
        if isSyntheticActivationAsserted {
            return true
        }
        guard
            let event = NSEvent.otherEvent(
                with: .appKitDefined,
                location: .zero,
                modifierFlags: [],
                timestamp: 0,
                windowNumber: 0,
                context: nil,
                subtype: syntheticApplicationActivatedEventSubtype,
                data1: 0,
                data2: 0
            ),
            let cgEvent = event.cgEvent
        else {
            return false
        }

        cgEvent.timestamp = CGEventTimestamp(
            ProcessInfo.processInfo.systemUptime * 1_000_000_000
        )
        ComputerUseSyntheticInputMarker.apply(to: cgEvent)
        cgEvent.postToPid(pid)
        setSyntheticActivationAsserted(true)
        return true
    }

    @discardableResult
    func notifyAppDeactivated() -> Bool {
        guard isSyntheticActivationAsserted else {
            return false
        }
        guard
            let event = NSEvent.otherEvent(
                with: .appKitDefined,
                location: .zero,
                modifierFlags: [],
                timestamp: 0,
                windowNumber: 0,
                context: nil,
                subtype: syntheticApplicationDeactivatedEventSubtype,
                data1: 0,
                data2: 0
            ),
            let cgEvent = event.cgEvent
        else {
            return false
        }

        cgEvent.timestamp = CGEventTimestamp(
            ProcessInfo.processInfo.systemUptime * 1_000_000_000
        )
        ComputerUseSyntheticInputMarker.apply(to: cgEvent)
        cgEvent.postToPid(pid)
        setSyntheticActivationAsserted(false)
        return true
    }

    /// Process-local window activation for Electron AX hydration.
    ///
    /// Codex posts AppKitDefined activation + key-focus-returned via
    /// `postToPid` only. A previous vendored sequence also injected a synthetic
    /// left-click pair into the window — that reorders the real window stack
    /// (visible flash) and is deliberately omitted here.
    ///
    /// Session-sticky: once asserted, no further events are posted.
    @discardableResult
    func notifyAppActivatedFromCGWindow() -> Bool {
        if isSyntheticActivationAsserted {
            return true
        }
        guard let candidate = preferredCGWindowCandidate() else {
            return false
        }

        let timestamp = CGEventTimestamp(
            ProcessInfo.processInfo.systemUptime * 1_000_000_000
        )
        var events: [CGEvent] = []

        if let event = NSEvent.otherEvent(
            with: .appKitDefined,
            location: .zero,
            modifierFlags: [.control, .option],
            timestamp: 0,
            windowNumber: Int(candidate.windowID),
            context: nil,
            subtype: syntheticApplicationActivatedEventSubtype,
            data1: 0,
            data2: 0
        ),
        let cgEvent = event.cgEvent
        {
            events.append(cgEvent)
        }

        // Official KeyFocusReturned is 0xF102, not 0x8000 (KeyFocusTaken).
        let keyFocusReturnedSubtype = Int16(bitPattern: 0xF102)
        if
            let processNotificationType = NSEvent.EventType(
                rawValue: syntheticProcessNotificationEventTypeRawValue
            ),
            let event = NSEvent.otherEvent(
                with: processNotificationType,
                location: .zero,
                modifierFlags: [],
                timestamp: 0,
                windowNumber: 0,
                context: nil,
                subtype: keyFocusReturnedSubtype,
                data1: 0,
                data2: 0
            ),
            let cgEvent = event.cgEvent
        {
            events.append(cgEvent)
        }

        guard events.count == 2 else {
            return false
        }

        for event in events {
            event.timestamp = timestamp
            ComputerUseSyntheticInputMarker.apply(to: event)
            event.postToPid(pid)
        }
        setSyntheticActivationAsserted(true)
        return true
    }

    private func enableAccessibility() -> AccessibilityEnablementState {
        AccessibilityEnablementState(
            manualAccessibilityEnabled: AXUIElementSetAttributeValue(
                appElement,
                "AXManualAccessibility" as CFString,
                kCFBooleanTrue
            ) == .success,
            enhancedUserInterfaceEnabled: AXUIElementSetAttributeValue(
                appElement,
                "AXEnhancedUserInterface" as CFString,
                kCFBooleanTrue
            ) == .success
        )
    }

    private var isSyntheticActivationAsserted: Bool {
        lock.withLock {
            syntheticActivationAsserted
        }
    }

    private func setSyntheticActivationAsserted(_ value: Bool) {
        lock.withLock {
            syntheticActivationAsserted = value
        }
    }

    private func startObservingApplication() {
        var createdObserver: AXObserver?
        guard AXObserverCreate(
            pid,
            accessibilitySessionObserverCallback,
            &createdObserver
        ) == .success,
        let createdObserver
        else {
            return
        }

        observer = createdObserver
        addNotifications(
            applicationInvalidationNotifications,
            to: appElement,
            observer: createdObserver
        )
        CFRunLoopAddSource(
            CFRunLoopGetMain(),
            AXObserverGetRunLoopSource(createdObserver),
            .commonModes
        )
    }

    private func addNotifications(
        _ notifications: [String],
        to element: AXUIElement,
        observer: AXObserver
    ) {
        let context = Unmanaged.passUnretained(self).toOpaque()
        for notification in notifications {
            _ = AXObserverAddNotification(
                observer,
                element,
                notification as CFString,
                context
            )
        }
    }

    private func removeNotifications(
        _ notifications: [String],
        from element: AXUIElement,
        observer: AXObserver
    ) {
        for notification in notifications {
            _ = AXObserverRemoveNotification(
                observer,
                element,
                notification as CFString
            )
        }
    }

    private func setAttributeIfSettable(
        _ attribute: String,
        value: CFTypeRef,
        on element: AXUIElement
    ) -> Bool {
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(
            element,
            attribute as CFString,
            &settable
        ) == .success,
        settable.boolValue
        else {
            return false
        }

        return AXUIElementSetAttributeValue(
            element,
            attribute as CFString,
            value
        ) == .success
    }

    private func preferredCGWindowCandidate() -> WindowCaptureCandidate? {
        guard let infoList = CGWindowListCopyWindowInfo(
            [.optionAll],
            kCGNullWindowID
        ) as? [[String: Any]] else {
            return nil
        }

        let candidates = infoList.enumerated().compactMap {
            offset,
            info -> WindowCaptureCandidate? in
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

            return WindowCaptureCandidate(
                windowID: CGWindowID(number.uint32Value),
                layer: layer,
                bounds: bounds,
                title: info[kCGWindowName as String] as? String,
                area: Int(bounds.width * bounds.height),
                frontToBackIndex: offset,
                isOnScreen: (info[kCGWindowIsOnscreen as String] as? NSNumber)?
                    .boolValue == true
            )
        }

        return preferredWindowCaptureCandidate(
            candidates,
            titleHint: nil,
            frameHint: nil
        )
    }

    private func containingWindow(of element: AXUIElement) -> AXUIElement? {
        var current = element

        for _ in 0..<24 {
            if stringAttribute(kAXRoleAttribute as String, of: current)
                == kAXWindowRole as String
            {
                return current
            }

            guard
                let parent = elementAttribute(
                    kAXParentAttribute as String,
                    of: current
                ),
                !CFEqual(parent, current)
            else {
                return nil
            }
            current = parent
        }

        return nil
    }

    private func elementAttribute(
        _ attribute: String,
        of element: AXUIElement
    ) -> AXUIElement? {
        var value: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(
                element,
                attribute as CFString,
                &value
            ) == .success,
            let value,
            CFGetTypeID(value) == AXUIElementGetTypeID()
        else {
            return nil
        }

        return (value as! AXUIElement)
    }

    private func stringAttribute(
        _ attribute: String,
        of element: AXUIElement
    ) -> String? {
        var value: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(
                element,
                attribute as CFString,
                &value
            ) == .success,
            let value,
            CFGetTypeID(value) == CFStringGetTypeID()
        else {
            return nil
        }

        return value as? String
    }
}

final class AccessibilitySessionRegistry {
    private var sessionsByPID: [pid_t: AccessibilitySession] = [:]

    func session(for app: RunningAppDescriptor) -> AccessibilitySession {
        sessionsByPID = sessionsByPID.filter { pid, _ in
            NSRunningApplication(processIdentifier: pid)?.isTerminated == false
        }

        if let existing = sessionsByPID[app.pid] {
            _ = existing.refreshAccessibilityEnablement()
            return existing
        }

        let session = AccessibilitySession(app: app)
        sessionsByPID[app.pid] = session
        return session
    }
}
