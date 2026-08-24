import AppKit
import CoreGraphics
import Foundation
import QuartzCore

public enum VisualCursorSupport {
    private static let mainQueueKey = DispatchSpecificKey<UInt8>()
    private static let mainQueueValue: UInt8 = 1
    private static let installMainQueueMarker: Void = {
        DispatchQueue.main.setSpecific(key: mainQueueKey, value: mainQueueValue)
    }()

    public static var isEnabled: Bool {
        visualCursorEnabled(environment: ProcessInfo.processInfo.environment)
    }

    static func performOnMain(_ body: @escaping @MainActor () -> Void) {
        _ = installMainQueueMarker
        // Embedders must run a real AppKit loop on the OS main thread. Still detect
        // the queue explicitly as a defensive measure: checking only the OS thread
        // can otherwise call main.sync while already executing on the main queue.
        let isOnMainQueue = DispatchQueue.getSpecific(key: mainQueueKey) == mainQueueValue
        if Thread.isMainThread || isOnMainQueue {
            MainActor.assumeIsolated {
                body()
            }
            return
        }

        DispatchQueue.main.sync {
            MainActor.assumeIsolated {
                body()
            }
        }
    }
}

func visualCursorEnabled(environment: [String: String]) -> Bool {
    guard let rawValue = environment["OPEN_COMPUTER_USE_VISUAL_CURSOR"]?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() else {
        return true
    }

    return !["0", "false", "no", "off"].contains(rawValue)
}

func defaultVisualCursorInitialTipPosition(
    windowOrigin: CGPoint = .zero,
    tipAnchor: CGPoint = SoftwareCursorGlyphMetrics.tipAnchor
) -> CGPoint {
    return CGPoint(
        x: windowOrigin.x + tipAnchor.x,
        y: windowOrigin.y + tipAnchor.y
    )
}

func visualCursorRenderBaseHeading(
    artworkNeutralHeading: CGFloat = SoftwareCursorGlyphMetrics.targetNeutralHeading
) -> CGFloat {
    artworkNeutralHeading
}

func visualCursorAppKitForwardHeading(
    renderRotation: CGFloat,
    artworkNeutralHeading: CGFloat = SoftwareCursorGlyphMetrics.targetNeutralHeading
) -> CGFloat {
    -artworkNeutralHeading - renderRotation
}

func visualCursorRuntimeRenderYAxisMultiplier() -> CGFloat {
    // Window placement uses AppKit global coordinates, but glyph render state is
    // still interpreted as CursorMotion's y-down screen state before drawing.
    -1
}

func visualCursorScreenStateVelocity(
    fromRuntimeVelocity velocity: CGVector,
    yAxisMultiplier: CGFloat
) -> CGVector {
    CGVector(dx: velocity.dx, dy: velocity.dy * yAxisMultiplier)
}

func visualCursorPostInteractionIdleTimeout() -> TimeInterval {
    // Keep the glyph briefly after a click so the user can "catch" it on the
    // target app, without leaving a stuck cursor for half a minute.
    2.5
}

func visualCursorIdleRotationAmplitude() -> CGFloat {
    // Zero so the resting glyph is upright on the target app (user-visible
    // "crooked cursor"). Path-driven rotation still applies while moving.
    0
}

public struct VisualCursorObservationPoint: Codable, Sendable {
    public let x: Double
    public let y: Double

    public init(point: CGPoint) {
        x = point.x
        y = point.y
    }
}

public struct VisualCursorObservationSnapshot: Codable, Sendable {
    public let phase: String
    public let tipPosition: VisualCursorObservationPoint?
    public let restingTipPosition: VisualCursorObservationPoint?
    public let rotation: Double?
    public let timestamp: Double

    public init(
        phase: String,
        tipPosition: CGPoint?,
        restingTipPosition: CGPoint?,
        rotation: CGFloat?,
        timestamp: CFTimeInterval
    ) {
        self.phase = phase
        self.tipPosition = tipPosition.map(VisualCursorObservationPoint.init(point:))
        self.restingTipPosition = restingTipPosition.map(VisualCursorObservationPoint.init(point:))
        self.rotation = rotation.map(Double.init)
        self.timestamp = timestamp
    }
}

struct VisualCursorIdlePose {
    let tipPosition: CGPoint
    let angleOffset: CGFloat
}

func visualCursorIdlePose(restingTipPosition: CGPoint, phase: CGFloat) -> VisualCursorIdlePose {
    VisualCursorIdlePose(
        tipPosition: restingTipPosition,
        angleOffset: sin(phase * 0.8) * visualCursorIdleRotationAmplitude()
    )
}

public func visualCursorObservationFileURL(environment: [String: String]) -> URL? {
    guard
        let rawPath = environment["OPEN_COMPUTER_USE_VISUAL_CURSOR_OBSERVATION_FILE"]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
        !rawPath.isEmpty
    else {
        return nil
    }

    return URL(fileURLWithPath: rawPath)
}

public let openComputerUseTurnEndedNotificationName = Notification.Name("com.ifuryst.opencomputeruse.turn-ended")

public func postOpenComputerUseTurnEndedNotification() {
    DistributedNotificationCenter.default().postNotificationName(
        openComputerUseTurnEndedNotificationName,
        object: nil,
        userInfo: nil,
        deliverImmediately: true
    )
}

public struct OpenComputerUseVisualCursorPresentation: Sendable {
    public let normalizedX: CGFloat
    public let normalizedY: CGFloat
    public let rotation: CGFloat
    public let active: Bool

    public init(normalizedX: CGFloat, normalizedY: CGFloat, rotation: CGFloat, active: Bool) {
        self.normalizedX = normalizedX
        self.normalizedY = normalizedY
        self.rotation = rotation
        self.active = active
    }
}

@MainActor
private enum OpenComputerUseVisualCursorPresentationBridge {
    static var handler: (@MainActor @Sendable (OpenComputerUseVisualCursorPresentation) -> Void)?
}

@MainActor
public func setOpenComputerUseVisualCursorPresentationHandler(
    _ handler: (@MainActor @Sendable (OpenComputerUseVisualCursorPresentation) -> Void)?
) {
    OpenComputerUseVisualCursorPresentationBridge.handler = handler
}

@MainActor
public func resetOpenComputerUseVisualCursor() {
    SoftwareCursorOverlay.reset()
}

struct CursorTargetWindow: Equatable, Sendable {
    let windowID: CGWindowID
    let layer: Int
    /// Screen-state (CG) bounds of the controlled window. Used to clamp the
    /// software cursor into the app even when CGWindowList can't resolve the id.
    let cgBounds: CGRect?

    init(windowID: CGWindowID, layer: Int, cgBounds: CGRect? = nil) {
        self.windowID = windowID
        self.layer = layer
        self.cgBounds = cgBounds
    }
}

struct CursorWindowGeometry {
    let windowSize: CGSize
    let tipAnchor: CGPoint

    func origin(forTipPosition tipPosition: CGPoint) -> CGPoint {
        CGPoint(
            x: tipPosition.x - tipAnchor.x,
            y: tipPosition.y - tipAnchor.y
        )
    }

    func tipPosition(forOrigin origin: CGPoint) -> CGPoint {
        CGPoint(
            x: origin.x + tipAnchor.x,
            y: origin.y + tipAnchor.y
        )
    }
}

private struct CursorArtwork {
    let geometry: CursorWindowGeometry
    static let active = CursorArtwork(
        geometry: CursorWindowGeometry(
            windowSize: SoftwareCursorGlyphMetrics.windowSize,
            tipAnchor: SoftwareCursorGlyphMetrics.tipAnchor
        ),
    )
}

@MainActor
enum SoftwareCursorOverlay {
    private static let artwork = CursorArtwork.active
    private static let renderBaseHeading = visualCursorRenderBaseHeading()
    private static let renderYAxisMultiplier = visualCursorRuntimeRenderYAxisMultiplier()
    private static var panel: CursorPanel?
    private static var cursorView: SoftwareCursorView?
    private static var restingTipPosition: CGPoint?
    private static var displayedTipPosition: CGPoint?
    private static var activeTargetWindow: CursorTargetWindow?
    private static var visualDynamicsState: CursorVisualDynamicsState?
    private static var idleTimer: Timer?
    private static var hideTimer: Timer?
    private static var idlePhase: CGFloat = 0
    private static var observationPhase = "hidden"

    static func moveCursor(to targetPoint: CGPoint, in targetWindow: CursorTargetWindow?) {
        guard VisualCursorSupport.isEnabled, canPresentOverlay else {
            return
        }

        prepareWindowIfNeeded()
        stopIdleAnimation()
        cancelPendingHide()
        configureOrdering(relativeTo: targetWindow)

        // Always land inside the target app first. Never start from screen origin
        // (defaultInitialTipPosition at .zero) which makes the glyph "fly in"
        // from outside the controlled window.
        let constrainedTarget = clampTipPosition(targetPoint, within: targetWindow)
        let startPoint = cursorEntryPoint(
            toward: constrainedTarget,
            targetWindow: targetWindow
        )
        let now = CACurrentMediaTime()

        observationPhase = "moving"
        panel?.alphaValue = 1
        // Teleport into the target region, then optionally do a short hop.
        visualDynamicsState = CursorVisualDynamicsAnimator.state(
            at: startPoint,
            time: CGFloat(now)
        )
        placeCursor(using: initialRenderState(at: startPoint), clickProgress: 0)

        if distanceBetween(startPoint, constrainedTarget) > 8 {
            animateMove(from: startPoint, to: constrainedTarget, relativeTo: targetWindow)
        } else {
            placeCursor(using: initialRenderState(at: constrainedTarget), clickProgress: 0)
            restingTipPosition = constrainedTarget
        }
    }

    static func pulseClick(at targetPoint: CGPoint, clickCount: Int, mouseButton: MouseButtonKind, in targetWindow: CursorTargetWindow?) {
        guard VisualCursorSupport.isEnabled, canPresentOverlay else {
            return
        }

        configureOrdering(relativeTo: targetWindow)
        let constrainedTarget = clampTipPosition(targetPoint, within: targetWindow)
        let now = CACurrentMediaTime()
        // Ensure we are already inside the app before pulsing — no fly-in.
        if displayedTipPosition == nil
            || !isTipInsideTarget(displayedTipPosition!, targetWindow: targetWindow)
        {
            visualDynamicsState = CursorVisualDynamicsAnimator.state(
                at: constrainedTarget,
                time: CGFloat(now)
            )
            placeCursor(using: initialRenderState(at: constrainedTarget), clickProgress: 0)
        }
        seedVisualDynamicsIfNeeded(at: constrainedTarget, time: now)
        restingTipPosition = constrainedTarget
        observationPhase = "pulse"
        animateClickPulse(at: constrainedTarget, clickCount: max(clickCount, 1), mouseButton: mouseButton)
        startIdleAnimation()
        scheduleHide(after: visualCursorPostInteractionIdleTimeout())
    }

    static func settle(at targetPoint: CGPoint, in targetWindow: CursorTargetWindow?) {
        guard VisualCursorSupport.isEnabled, canPresentOverlay else {
            return
        }

        configureOrdering(relativeTo: targetWindow)
        let constrainedTarget = clampTipPosition(targetPoint, within: targetWindow)
        restingTipPosition = constrainedTarget
        observationPhase = "settling"
        placeCursor(
            using: advanceVisualDynamics(
                toward: constrainedTarget,
                at: CACurrentMediaTime()
            ),
            clickProgress: 0
        )
        startIdleAnimation()
        scheduleHide(after: visualCursorPostInteractionIdleTimeout())
    }

    static func reset() {
        stopIdleAnimation()
        cancelPendingHide()
        displayedTipPosition = nil
        restingTipPosition = nil
        activeTargetWindow = nil
        visualDynamicsState = nil
        observationPhase = "hidden"
        writeObservationSnapshot(tipPosition: nil, rotation: nil)
        publishCursorPresentation(active: false)
        panel?.orderOut(nil)
    }

    private static var canPresentOverlay: Bool {
        !NSScreen.screens.isEmpty
    }

    private static func prepareWindowIfNeeded() {
        guard panel == nil else {
            return
        }

        let panel = CursorPanel(
            contentRect: CGRect(origin: .zero, size: artwork.geometry.windowSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .normal
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.animationBehavior = .none

        let view = SoftwareCursorView(frame: CGRect(origin: .zero, size: artwork.geometry.windowSize))
        panel.contentView = view

        self.panel = panel
        self.cursorView = view
    }

    private static func configureOrdering(relativeTo targetWindow: CursorTargetWindow?) {
        configureOrdering(relativeTo: targetWindow, forceReorder: false)
    }

    private static func configureOrdering(relativeTo targetWindow: CursorTargetWindow?, forceReorder: Bool) {
        guard let panel else {
            return
        }

        let effectiveTargetWindow = targetWindow.flatMap { targetWindow in
            isWindowPresent(targetWindow.windowID) ? targetWindow : nil
        }

        // Codex model: the software cursor lives in the *target app's* window
        // stack (`order(.above, relativeTo: targetWindowID)`), not as a global
        // floating panel. That way:
        //   - when the user is in Operon, the cursor is not painted on top of it
        //   - when they bring the controlled app forward, the cursor is there
        //
        // Important: do NOT force-reorder every animation frame. Repeated
        // relative-order calls are what yanked the target window to front and
        // produced the visible flash. Reorder only when the target changes or
        // the panel is not yet attached.
        guard let effectiveTargetWindow else {
            // No attachable target — hide rather than floating over the desktop.
            if panel.isVisible {
                panel.orderOut(nil)
            }
            activeTargetWindow = nil
            return
        }

        let desiredLevel = NSWindow.Level(rawValue: effectiveTargetWindow.layer)
        if panel.level != desiredLevel {
            panel.level = desiredLevel
        }

        if shouldReorderCursorPanel(
            activeTargetWindow: activeTargetWindow,
            effectiveTargetWindow: effectiveTargetWindow,
            panelIsVisible: panel.isVisible,
            forceReorder: forceReorder
        ) {
            panel.order(.above, relativeTo: Int(effectiveTargetWindow.windowID))
            activeTargetWindow = effectiveTargetWindow
        }
    }

    private static func animateMove(from start: CGPoint, to end: CGPoint, relativeTo targetWindow: CursorTargetWindow?) {
        let candidate = bestMotionCandidate(from: start, to: end, relativeTo: targetWindow)
        let path = candidate.path
        // Use the recovered official progress spring timing instead of the older
        // distance-compressed local duration, otherwise medium and long moves feel
        // noticeably faster than the bundled app.
        let duration = OfficialCursorMotionModel.calibratedTravelDuration(
            distance: distanceBetween(start, end),
            measurement: candidate.measurement
        )
        let springTargetDuration = OfficialCursorMotionModel.closeEnoughTime
        let startTime = CACurrentMediaTime()
        var progress: CGFloat = 0
        var springState = CursorMotionSpringState()

        while true {
            refreshActiveOrderingIfNeeded()

            let elapsed = CGFloat(CACurrentMediaTime() - startTime)
            let normalizedElapsed = (elapsed / max(duration, 0.001)).clamped(to: 0...1)
            let springTime = normalizedElapsed * springTargetDuration
            (progress, springState) = CursorMotionProgressAnimator.advance(
                current: progress,
                state: springState,
                to: springTime
            )

            let sample = path.sample(at: progress)
            placeCursor(
                using: advanceVisualDynamics(
                    toward: sample.point,
                    at: CACurrentMediaTime(),
                    within: targetWindow
                ),
                clickProgress: 0
            )

            if normalizedElapsed >= 1 || CursorMotionProgressAnimator.isCloseEnough(progress: progress) {
                break
            }

            pumpFrame()
        }

        placeCursor(
            using: advanceVisualDynamics(
                toward: end,
                at: CACurrentMediaTime(),
                within: targetWindow
            ),
            clickProgress: 0
        )
    }

    private static func bestMotionCandidate(from start: CGPoint, to end: CGPoint, relativeTo targetWindow: CursorTargetWindow?) -> CursorMotionCandidate {
        let bounds = motionBounds(from: start, to: end)
        let candidates = HeadingDrivenCursorMotionModel.makeCandidates(
            start: start,
            end: end,
            bounds: bounds,
            startForward: currentForwardVector(),
            endForward: restingForwardVector()
        )
        let defaultCandidate = HeadingDrivenCursorMotionModel.chooseBestCandidate(from: candidates)
            ?? CursorMotionCandidate(
                identifier: "legacy-fallback",
                kind: .base,
                side: 0,
                tableAScale: nil,
                tableBScale: nil,
                path: CursorMotionPath(start: start, end: end),
                measurement: CursorMotionPath(start: start, end: end).measure(bounds: bounds),
                score: 0
            )

        guard let targetWindow else {
            return defaultCandidate
        }

        let excludingWindowNumber = max(panel?.windowNumber ?? 0, 0)
        let evaluations = candidates.map { candidate in
            (
                candidate: candidate,
                hitCount: windowConstraintHitCount(
                    for: candidate.path,
                    relativeTo: targetWindow,
                    excludingWindowNumber: excludingWindowNumber
                )
            )
        }

        let totalSampleCount = candidates.first?.path.sampledConstraintPoints().count ?? 0
        let bestHitCount = evaluations.map(\.hitCount).max() ?? 0

        if bestHitCount == totalSampleCount, bestHitCount > 0 {
            return evaluations
                .filter { $0.hitCount == bestHitCount }
                .map(\.candidate)
                .sorted(by: candidatePreference)
                .first ?? defaultCandidate
        }

        if bestHitCount > 0 {
            return evaluations
                .filter { $0.hitCount == bestHitCount }
                .map(\.candidate)
                .sorted(by: candidatePreference)
                .first ?? defaultCandidate
        }

        return defaultCandidate
    }

    private static func currentForwardVector() -> CGVector {
        let renderRotation = cursorView?.rotation ?? 0
        return forwardVector(renderRotation: renderRotation)
    }

    private static func restingForwardVector() -> CGVector {
        forwardVector(renderRotation: 0)
    }

    private static func forwardVector(renderRotation: CGFloat) -> CGVector {
        let angle = visualCursorAppKitForwardHeading(renderRotation: renderRotation)
        return CGVector(dx: cos(angle), dy: sin(angle))
    }

    private static func windowConstraintHitCount(
        for path: CursorMotionPath,
        relativeTo targetWindow: CursorTargetWindow,
        excludingWindowNumber: Int
    ) -> Int {
        path.sampledConstraintPoints().reduce(into: 0) { result, point in
            if windowID(at: point, excludingWindowNumber: excludingWindowNumber) == targetWindow.windowID {
                result += 1
            }
        }
    }

    private static func motionBounds(from start: CGPoint, to end: CGPoint) -> CGRect? {
        let startScreen = screen(containing: start) ?? NSScreen.main ?? NSScreen.screens.first
        let endScreen = screen(containing: end) ?? startScreen

        switch (startScreen, endScreen) {
        case let (startScreen?, endScreen?) where startScreen === endScreen:
            return startScreen.visibleFrame
        case let (startScreen?, endScreen?):
            return startScreen.visibleFrame.union(endScreen.visibleFrame)
        case let (screen?, nil), let (nil, screen?):
            return screen.visibleFrame
        default:
            return nil
        }
    }

    private static func candidatePreference(_ lhs: CursorMotionCandidate, _ rhs: CursorMotionCandidate) -> Bool {
        if lhs.measurement.staysInBounds != rhs.measurement.staysInBounds {
            return lhs.measurement.staysInBounds && !rhs.measurement.staysInBounds
        }
        if lhs.score != rhs.score {
            return lhs.score < rhs.score
        }
        return lhs.identifier < rhs.identifier
    }

    private static func windowID(at point: CGPoint, excludingWindowNumber: Int) -> CGWindowID? {
        let windowNumber = NSWindow.windowNumber(
            at: NSPoint(x: point.x, y: point.y),
            belowWindowWithWindowNumber: excludingWindowNumber
        )

        guard windowNumber > 0 else {
            return nil
        }

        return CGWindowID(windowNumber)
    }

    private static func isWindowPresent(_ windowID: CGWindowID) -> Bool {
        guard windowID != 0,
              let windowInfo = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]]
        else {
            return false
        }

        return !windowInfo.isEmpty
    }

    private static func refreshActiveOrderingIfNeeded() {
        guard let activeTargetWindow else {
            return
        }

        // Never forceReorder here — the animation loop would re-order the target
        // window dozens of times per second and flash it to the front.
        if isWindowPresent(activeTargetWindow.windowID) {
            if panel?.isVisible != true {
                configureOrdering(relativeTo: activeTargetWindow, forceReorder: false)
            }
            return
        }

        configureOrdering(relativeTo: nil)
    }

    private static func animateClickPulse(at point: CGPoint, clickCount: Int, mouseButton: MouseButtonKind) {
        let pulseBias: CGFloat = mouseButton == .right ? 0.82 : 1

        for pulse in 0..<clickCount {
            let duration = 0.16
            let startTime = CACurrentMediaTime()

            while true {
                let elapsed = CACurrentMediaTime() - startTime
                let rawProgress = min(max(elapsed / duration, 0), 1)
                let clickProgress = sin(rawProgress * .pi) * pulseBias

                placeCursor(
                    using: advanceVisualDynamics(
                        toward: point,
                        at: CACurrentMediaTime()
                    ),
                    clickProgress: clickProgress
                )

                if rawProgress >= 1 {
                    break
                }

                pumpFrame()
            }

            if pulse < clickCount - 1 {
                pause(for: 0.05)
            }
        }

        placeCursor(
            using: advanceVisualDynamics(
                toward: point,
                at: CACurrentMediaTime()
            ),
            clickProgress: 0
        )
    }

    private static func startIdleAnimation() {
        guard canPresentOverlay, let restingTipPosition else {
            return
        }

        observationPhase = "idle"
        idlePhase = 0
        let timer = Timer(timeInterval: 1 / 60, repeats: true) { _ in
            MainActor.assumeIsolated {
                guard panel != nil, cursorView != nil else {
                    return
                }

                refreshActiveOrderingIfNeeded()

                observationPhase = "idle"
                idlePhase += 0.05
                let idlePose = visualCursorIdlePose(
                    restingTipPosition: restingTipPosition,
                    phase: idlePhase
                )

                placeCursor(
                    using: advanceVisualDynamics(
                        toward: idlePose.tipPosition,
                        idleAngleOffset: idlePose.angleOffset,
                        at: CACurrentMediaTime()
                    ),
                    clickProgress: 0
                )
            }
        }

        RunLoop.main.add(timer, forMode: .common)
        idleTimer = timer

        placeCursor(
            using: advanceVisualDynamics(
                toward: restingTipPosition,
                at: CACurrentMediaTime()
            ),
            clickProgress: 0
        )
    }

    private static func stopIdleAnimation() {
        idleTimer?.invalidate()
        idleTimer = nil
    }

    private static func scheduleHide(after delay: TimeInterval) {
        cancelPendingHide()
        let timer = Timer(timeInterval: delay, repeats: false) { _ in
            MainActor.assumeIsolated {
                hideOverlay()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        hideTimer = timer
    }

    private static func cancelPendingHide() {
        hideTimer?.invalidate()
        hideTimer = nil
    }

    private static func hideOverlay() {
        guard let panel else {
            return
        }

        stopIdleAnimation()
        cancelPendingHide()

        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            panel.animator().alphaValue = 0
        } completionHandler: {
            MainActor.assumeIsolated {
                panel.orderOut(nil)
                panel.alphaValue = 1
                displayedTipPosition = nil
                restingTipPosition = nil
                activeTargetWindow = nil
                visualDynamicsState = nil
                observationPhase = "hidden"
                writeObservationSnapshot(tipPosition: nil, rotation: nil)
                publishCursorPresentation(active: false)
            }
        }
    }

    private static func defaultInitialTipPosition() -> CGPoint {
        defaultVisualCursorInitialTipPosition(
            windowOrigin: .zero,
            tipAnchor: artwork.geometry.tipAnchor
        )
    }

    /// Entry tip for a move. Stay inside the controlled app: reuse the last
    /// in-window tip when nearby, otherwise materialize *at* the target (never
    /// from screen origin or outside the app — that is the visible "fly-in").
    private static func cursorEntryPoint(
        toward target: CGPoint,
        targetWindow: CursorTargetWindow?
    ) -> CGPoint {
        let clampedTarget = clampTipPosition(target, within: targetWindow)
        if let previous = displayedTipPosition,
           isTipInsideTarget(previous, targetWindow: targetWindow),
           distanceBetween(previous, clampedTarget) < 520
        {
            return previous
        }
        return clampedTarget
    }

    private static func isTipInsideTarget(
        _ tip: CGPoint,
        targetWindow: CursorTargetWindow?
    ) -> Bool {
        guard let appKitBounds = appKitBounds(of: targetWindow) else {
            // No known app frame — treat as outside so we teleport to target
            // instead of animating from a stale off-app position.
            return false
        }
        return appKitBounds.insetBy(dx: 4, dy: 4).contains(tip)
    }

    private static func appKitBounds(of targetWindow: CursorTargetWindow?) -> CGRect? {
        guard let targetWindow else {
            return nil
        }
        let cgBounds = cgWindowBounds(of: targetWindow.windowID) ?? targetWindow.cgBounds
        guard let cgBounds, cgBounds.width > 1, cgBounds.height > 1 else {
            return nil
        }
        // CGWindow bounds are top-left origin (same as CGDisplayBounds).
        let topLeft = CGPoint(x: cgBounds.minX, y: cgBounds.minY)
        let bottomRight = CGPoint(x: cgBounds.maxX, y: cgBounds.maxY)
        let appKitTopLeft = screenStatePointToAppKitGlobalPoint(fromScreenStatePoint: topLeft)
        let appKitBottomRight = screenStatePointToAppKitGlobalPoint(fromScreenStatePoint: bottomRight)
        let minX = min(appKitTopLeft.x, appKitBottomRight.x)
        let maxX = max(appKitTopLeft.x, appKitBottomRight.x)
        let minY = min(appKitTopLeft.y, appKitBottomRight.y)
        let maxY = max(appKitTopLeft.y, appKitBottomRight.y)
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    private static func cgWindowBounds(of windowID: CGWindowID) -> CGRect? {
        guard windowID != 0,
              let infoList = CGWindowListCopyWindowInfo(
                [.optionIncludingWindow],
                windowID
              ) as? [[String: Any]],
              let info = infoList.first,
              let boundsDictionary = info[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: boundsDictionary)
        else {
            return nil
        }
        return bounds
    }

    private static func initialRenderState(at tipPosition: CGPoint) -> CursorVisualRenderState {
        CursorVisualRenderState(
            tipPosition: tipPosition,
            rotation: 0,
            cursorBodyOffset: CGVector(dx: 0, dy: 0),
            fogOffset: CGVector(dx: 0, dy: 0),
            fogOpacity: CursorVisualDynamicsConfiguration.officialInspired.fogOpacityBase,
            fogScale: 1
        )
    }

    private static func seedVisualDynamicsIfNeeded(at tipPosition: CGPoint, time: CFTimeInterval) {
        guard visualDynamicsState == nil else {
            return
        }

        visualDynamicsState = CursorVisualDynamicsAnimator.state(
            at: tipPosition,
            time: CGFloat(time)
        )
    }

    private static func advanceVisualDynamics(
        toward targetTipPosition: CGPoint,
        idleAngleOffset: CGFloat = 0,
        at time: CFTimeInterval,
        within targetWindow: CursorTargetWindow? = nil
    ) -> CursorVisualRenderState {
        // Prefer the interaction window so motion/idle never leaves the app.
        let clampWindow = targetWindow ?? activeTargetWindow
        let clampedTarget = clampTipPosition(targetTipPosition, within: clampWindow)
        seedVisualDynamicsIfNeeded(at: clampedTarget, time: time)

        let result = CursorVisualDynamicsAnimator.advance(
            state: visualDynamicsState ?? CursorVisualDynamicsAnimator.state(at: clampedTarget, time: CGFloat(time)),
            targetTipPosition: clampedTarget,
            targetTime: CGFloat(time),
            idleAngleOffset: idleAngleOffset,
            baseHeading: renderBaseHeading,
            renderYAxisMultiplier: renderYAxisMultiplier
        )
        visualDynamicsState = result.state
        // Re-clamp the rendered tip so spring overshoot cannot leave the app.
        var render = result.renderState
        let tip = clampTipPosition(render.tipPosition, within: clampWindow)
        if tip != render.tipPosition {
            render = CursorVisualRenderState(
                tipPosition: tip,
                rotation: render.rotation,
                cursorBodyOffset: render.cursorBodyOffset,
                fogOffset: render.fogOffset,
                fogOpacity: render.fogOpacity,
                fogScale: render.fogScale
            )
        }
        return render
    }

    private static func placeCursor(using renderState: CursorVisualRenderState, clickProgress: CGFloat) {
        guard let panel, let cursorView else {
            return
        }

        panel.setFrameOrigin(artwork.geometry.origin(forTipPosition: renderState.tipPosition))
        cursorView.rotation = renderState.rotation
        cursorView.cursorBodyOffset = renderState.cursorBodyOffset
        cursorView.fogOffset = renderState.fogOffset
        cursorView.fogOpacity = renderState.fogOpacity
        cursorView.fogScale = renderState.fogScale
        cursorView.clickProgress = clickProgress
        cursorView.needsDisplay = true
        displayedTipPosition = renderState.tipPosition
        writeObservationSnapshot(
            tipPosition: renderState.tipPosition,
            rotation: renderState.rotation
        )
        publishCursorPresentation(
            tipPosition: renderState.tipPosition,
            rotation: renderState.rotation,
            active: true
        )
    }

    private static func publishCursorPresentation(
        tipPosition: CGPoint = .zero,
        rotation: CGFloat = 0,
        active: Bool
    ) {
        guard let handler = OpenComputerUseVisualCursorPresentationBridge.handler else {
            return
        }
        guard active,
              let bounds = appKitBounds(of: activeTargetWindow),
              bounds.width > 1,
              bounds.height > 1
        else {
            handler(OpenComputerUseVisualCursorPresentation(
                normalizedX: 0,
                normalizedY: 0,
                rotation: 0,
                active: false
            ))
            return
        }
        handler(OpenComputerUseVisualCursorPresentation(
            normalizedX: ((tipPosition.x - bounds.minX) / bounds.width).clamped(to: 0...1),
            normalizedY: ((bounds.maxY - tipPosition.y) / bounds.height).clamped(to: 0...1),
            rotation: rotation,
            active: true
        ))
    }

    private static func writeObservationSnapshot(tipPosition: CGPoint?, rotation: CGFloat?) {
        guard
            let url = visualCursorObservationFileURL(environment: ProcessInfo.processInfo.environment)
        else {
            return
        }

        let snapshot = VisualCursorObservationSnapshot(
            phase: observationPhase,
            tipPosition: tipPosition,
            restingTipPosition: restingTipPosition,
            rotation: rotation,
            timestamp: CACurrentMediaTime()
        )

        do {
            let directory = url.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(snapshot)
            try data.write(to: url, options: .atomic)
        } catch {
            // Observation is debug-only and must not affect tool execution.
        }
    }

    private static func clampTipPosition(_ tipPosition: CGPoint) -> CGPoint {
        clampTipPosition(tipPosition, within: nil)
    }

    private static func clampTipPosition(
        _ tipPosition: CGPoint,
        within targetWindow: CursorTargetWindow?
    ) -> CGPoint {
        // Prefer the controlled app's frame so the glyph never sits outside it.
        if let appKitBounds = appKitBounds(of: targetWindow), appKitBounds.width > 8, appKitBounds.height > 8 {
            let inset = appKitBounds.insetBy(dx: 10, dy: 10)
            let frame = inset.isNull || inset.isEmpty ? appKitBounds : inset
            return CGPoint(
                x: tipPosition.x.clamped(to: frame.minX...frame.maxX),
                y: tipPosition.y.clamped(to: frame.minY...frame.maxY)
            )
        }

        guard let screen = screen(containing: tipPosition) ?? NSScreen.main ?? NSScreen.screens.first else {
            return tipPosition
        }

        let visibleFrame = screen.visibleFrame
        let minX = visibleFrame.minX + artwork.geometry.tipAnchor.x
        let maxX = visibleFrame.maxX - (artwork.geometry.windowSize.width - artwork.geometry.tipAnchor.x)
        let minY = visibleFrame.minY + artwork.geometry.tipAnchor.y
        let maxY = visibleFrame.maxY - (artwork.geometry.windowSize.height - artwork.geometry.tipAnchor.y)

        return CGPoint(
            x: tipPosition.x.clamped(to: minX...maxX),
            y: tipPosition.y.clamped(to: minY...maxY)
        )
    }

    private static func screen(containing point: CGPoint) -> NSScreen? {
        NSScreen.screens.first { $0.frame.contains(point) }
    }

    private static func pumpFrame() {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(1 / 120))
    }

    private static func pause(for duration: TimeInterval) {
        let start = CACurrentMediaTime()
        while CACurrentMediaTime() - start < duration {
            pumpFrame()
        }
    }

    private static func distanceBetween(_ lhs: CGPoint, _ rhs: CGPoint) -> CGFloat {
        hypot(rhs.x - lhs.x, rhs.y - lhs.y)
    }
}

func shouldReorderCursorPanel(
    activeTargetWindow: CursorTargetWindow?,
    effectiveTargetWindow: CursorTargetWindow?,
    panelIsVisible: Bool,
    forceReorder: Bool
) -> Bool {
    forceReorder || activeTargetWindow != effectiveTargetWindow || panelIsVisible == false
}

private final class CursorPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class SoftwareCursorView: NSView {
    var rotation: CGFloat = 0
    var cursorBodyOffset: CGVector = CGVector(dx: 0, dy: 0)
    var fogOffset: CGVector = CGVector(dx: 0, dy: 0)
    var fogOpacity: CGFloat = 0.12
    var fogScale: CGFloat = 1
    var clickProgress: CGFloat = 0

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var isOpaque: Bool {
        false
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)

        NSColor.clear.setFill()
        dirtyRect.fill()

        guard let context = NSGraphicsContext.current?.cgContext else {
            return
        }

        SoftwareCursorGlyphRenderer.draw(
            in: bounds,
            context: context,
            state: SoftwareCursorGlyphRenderState(
                rotation: rotation,
                cursorBodyOffset: cursorBodyOffset,
                fogOffset: fogOffset,
                fogOpacity: fogOpacity,
                fogScale: fogScale,
                clickProgress: clickProgress
            )
        )
    }
}
