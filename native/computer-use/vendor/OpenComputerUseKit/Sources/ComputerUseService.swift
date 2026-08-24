import AppKit
import ApplicationServices
import Foundation
import ImageIO
import OperonAccessibilitySupport

struct VisualCursorTarget: Equatable {
    let point: CGPoint
    let window: CursorTargetWindow?
}

struct VisualCursorScreenMapping: Equatable {
    let screenStateFrame: CGRect
    let appKitFrame: CGRect
}

func currentVisualCursorScreenMappings() -> [VisualCursorScreenMapping] {
    NSScreen.screens.compactMap { screen in
        guard let screenNumber = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else {
            return nil
        }

        return VisualCursorScreenMapping(
            screenStateFrame: CGDisplayBounds(CGDirectDisplayID(screenNumber.uint32Value)),
            appKitFrame: screen.frame
        )
    }
}

func screenStatePointToAppKitGlobalPoint(
    fromScreenStatePoint point: CGPoint,
    screenMappings: [VisualCursorScreenMapping] = currentVisualCursorScreenMappings()
) -> CGPoint {
    guard let mapping = screenMappings.first(where: { $0.screenStateFrame.contains(point) }) else {
        return point
    }

    let localX = point.x - mapping.screenStateFrame.minX
    let localY = point.y - mapping.screenStateFrame.minY

    return CGPoint(
        x: mapping.appKitFrame.minX + localX,
        y: mapping.appKitFrame.maxY - localY
    )
}

func visualCursorAppKitPoint(
    fromScreenStatePoint point: CGPoint,
    screenMappings: [VisualCursorScreenMapping] = currentVisualCursorScreenMappings()
) -> CGPoint {
    screenStatePointToAppKitGlobalPoint(
        fromScreenStatePoint: point,
        screenMappings: screenMappings
    )
}

func inputEventPoint(
    fromScreenStatePoint point: CGPoint,
    screenMappings: [VisualCursorScreenMapping] = currentVisualCursorScreenMappings()
) -> CGPoint {
    point
}

func makeVisualCursorTarget(
    at point: CGPoint,
    targetWindowID: CGWindowID?,
    targetWindowLayer: Int?,
    windowBounds: CGRect? = nil,
    screenMappings: [VisualCursorScreenMapping] = currentVisualCursorScreenMappings()
) -> VisualCursorTarget {
    let window: CursorTargetWindow?
    if let targetWindowID {
        window = CursorTargetWindow(
            windowID: targetWindowID,
            layer: targetWindowLayer ?? 0,
            cgBounds: windowBounds
        )
    } else if let windowBounds, windowBounds.width > 1, windowBounds.height > 1 {
        // AX-only capture has no CG window id; still attach bounds so the
        // software cursor can clamp into the app frame.
        window = CursorTargetWindow(windowID: 0, layer: targetWindowLayer ?? 0, cgBounds: windowBounds)
    } else {
        window = nil
    }
    return VisualCursorTarget(
        point: screenStatePointToAppKitGlobalPoint(
            fromScreenStatePoint: point,
            screenMappings: screenMappings
        ),
        window: window
    )
}

func makeVisualCursorTarget(
    localFrame: CGRect?,
    windowBounds: CGRect?,
    targetWindowID: CGWindowID?,
    targetWindowLayer: Int?,
    screenMappings: [VisualCursorScreenMapping] = currentVisualCursorScreenMappings()
) -> VisualCursorTarget? {
    guard let localFrame, let windowBounds else {
        return nil
    }

    let point = CGPoint(
        x: windowBounds.minX + localFrame.midX,
        y: windowBounds.minY + localFrame.midY
    )
    return makeVisualCursorTarget(
        at: point,
        targetWindowID: targetWindowID,
        targetWindowLayer: targetWindowLayer,
        windowBounds: windowBounds,
        screenMappings: screenMappings
    )
}

func inputFallbackDebugEnabled(environment: [String: String]) -> Bool {
    guard let rawValue = environment["OPEN_COMPUTER_USE_DEBUG_INPUT_FALLBACKS"]?
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
    else {
        return false
    }

    return ["1", "true", "yes", "on"].contains(rawValue)
}

/// Gate for the global-HID pointer fallback.
///
/// **What it actually covers:** every call site reaches the fallback from a
/// `catch`, and the targeted path only throws when the event cannot be *built*
/// (no `CGEventSource`, `NSEvent.mouseEvent` returned nil). `postToPid` itself
/// returns void and never throws, so an event that is constructed, posted and
/// then silently ignored by the target **does not** trigger this fallback.
///
/// That is deliberate, not an oversight to "fix" by falling back on no-effect:
/// a click legitimately may not change anything (re-clicking a selected row,
/// toggling something the AX tree doesn't model), and the fallback moves the
/// user's real cursor. Auto-firing it on "nothing changed" would yank the
/// pointer during false positives. Codex has no effect-based fallback either.
func globalPointerFallbacksEnabled(environment: [String: String]) -> Bool {
    guard let rawValue = environment["OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS"]?
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
    else {
        return false
    }

    return ["1", "true", "yes", "on"].contains(rawValue)
}

func screenshotPixelScale(
    screenshotPixelSize: CGSize?,
    windowBounds: CGRect?
) -> CGSize {
    guard
        let screenshotPixelSize,
        let windowBounds,
        windowBounds.width > 0,
        windowBounds.height > 0,
        screenshotPixelSize.width > 0,
        screenshotPixelSize.height > 0
    else {
        return CGSize(width: 1, height: 1)
    }

    return CGSize(
        width: screenshotPixelSize.width / windowBounds.width,
        height: screenshotPixelSize.height / windowBounds.height
    )
}

func screenshotPixelToWindowPoint(
    _ point: CGPoint,
    screenshotPixelSize: CGSize?,
    windowBounds: CGRect?
) -> CGPoint {
    let scale = screenshotPixelScale(
        screenshotPixelSize: screenshotPixelSize,
        windowBounds: windowBounds
    )
    return CGPoint(
        x: point.x / scale.width,
        y: point.y / scale.height
    )
}

let nonSettableSetValueErrorMessage = "Cannot set a value for an element that is not settable"

func setValueAttributeIsSettable(result: AXError, settable: Bool, attribute: String) throws -> Bool {
    guard result == .success else {
        throw ComputerUseError.message("AXUIElementIsAttributeSettable(\(attribute)) failed with \(result.rawValue)")
    }

    return settable
}

func invalidSecondaryActionErrorMessage(action: String, elementIndex: Int) -> String {
    "\(action) is not a valid secondary action for \(elementIndex)"
}

func localClickActionPoints(frame: CGRect, isSyntheticText: Bool) -> [CGPoint] {
    let center = CGPoint(x: frame.midX, y: frame.midY)
    let leading = CGPoint(
        x: frame.minX + min(max(frame.width * 0.3, 20), max(frame.width - 4, 20)),
        y: frame.midY
    )

    if isSyntheticText {
        return [leading]
    }

    if abs(leading.x - center.x) < 1 {
        return [center]
    }

    return [center, leading]
}

func isLikelySyntheticSideActionCandidate(
    parentFrame: CGRect?,
    candidateFrame: CGRect?,
    hasPrimaryAction: Bool,
    labels: [String]
) -> Bool {
    let hasSideActionLabel = labels.contains { label in
        let normalized = label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else {
            return false
        }

        if normalized == "完成" || normalized == "done" || normalized == "complete" || normalized == "archive" {
            return true
        }

        if normalized.count <= 24 {
            if normalized.contains("完成") {
                return true
            }

            if normalized.contains("mark") && (normalized.contains("done") || normalized.contains("complete")) {
                return true
            }
        }

        return false
    }

    guard let parentFrame, let candidateFrame else {
        return false
    }

    let trailingBandWidth = min(max(parentFrame.width * 0.22, 56), 140)
    let isTrailing = candidateFrame.midX >= parentFrame.maxX - trailingBandWidth
    let compactWidth = candidateFrame.width <= max(88, parentFrame.width * 0.18)
    let compactHeight = candidateFrame.height <= max(44, parentFrame.height * 1.2)
    let isCompact = compactWidth && compactHeight

    if hasSideActionLabel && hasPrimaryAction && isCompact {
        return true
    }

    return isTrailing && isCompact && (hasPrimaryAction || hasSideActionLabel)
}

func shouldScanDescendantsOfHitRecord(originalFrame: CGRect?, hitFrame: CGRect?) -> Bool {
    guard let originalFrame, let hitFrame else {
        return true
    }

    let originalArea = max(originalFrame.width * originalFrame.height, 1)
    let hitArea = hitFrame.width * hitFrame.height
    if hitArea > max(originalArea * 12, 20_000) {
        return false
    }

    if hitFrame.height > max(originalFrame.height * 4, 96),
       hitFrame.width > max(originalFrame.width * 2, 240)
    {
        return false
    }

    return true
}

func isLikelyContainingRowActionFrame(
    targetFrame: CGRect,
    candidateFrame: CGRect?,
    hasPrimaryAction: Bool
) -> Bool {
    let targetCenter = CGPoint(x: targetFrame.midX, y: targetFrame.midY)
    guard
        hasPrimaryAction,
        let candidateFrame,
        candidateFrame.insetBy(dx: -2, dy: -2).contains(targetCenter),
        candidateFrame.width >= targetFrame.width,
        candidateFrame.height >= targetFrame.height,
        candidateFrame.height <= max(targetFrame.height + 32, targetFrame.height * 2)
    else {
        return false
    }

    return true
}

func canUseActivationOnlyClickFallback(role: String?) -> Bool {
    guard let role else {
        return false
    }

    return role == kAXWindowRole as String
}

func canUseKeyboardTextFallback(role: String?, roleDescription: String?, isValueSettable: Bool) -> Bool {
    if isValueSettable {
        return true
    }

    guard let role else {
        return false
    }

    if role == kAXTextFieldRole as String || role == "AXTextArea" || role == "AXTextView" {
        return true
    }

    guard let roleDescription = roleDescription?.lowercased() else {
        return false
    }

    return roleDescription.contains("text field")
        || roleDescription.contains("text area")
        || roleDescription.contains("text entry")
}

/// Prefer the containing web row when clicking static text / groups inside a
/// web area (generic AX behavior — not app-specific).
func shouldPreferContainingWebRowAXClickCandidate(
    role: String?,
    isSyntheticText: Bool,
    hasWebAreaAncestor: Bool,
    appName: String,
    bundleIdentifier: String?
) -> Bool {
    _ = appName
    _ = bundleIdentifier
    guard hasWebAreaAncestor else {
        return false
    }

    guard let role else {
        return isSyntheticText
    }

    return role == kAXStaticTextRole as String || role == kAXGroupRole as String || isSyntheticText
}

struct AccessibilityElementIdentity: Equatable {
    let identifier: String?
    let role: String?
    let title: String?
    let localFrame: CGRect?
    let isSyntheticText: Bool
}

func accessibilityElementRefetchScore(
    previous: AccessibilityElementIdentity,
    candidate: AccessibilityElementIdentity
) -> Int? {
    guard previous.isSyntheticText == candidate.isSyntheticText else {
        return nil
    }
    if let previousRole = previous.role,
       let candidateRole = candidate.role,
       previousRole != candidateRole
    {
        return nil
    }

    var score = 0
    if let identifier = previous.identifier,
       !identifier.isEmpty
    {
        guard candidate.identifier == identifier else {
            return nil
        }
        score += 1_000
    }

    if let title = previous.title,
       !title.isEmpty
    {
        guard candidate.title == title else {
            return nil
        }
        score += 200
    }

    if let previousFrame = previous.localFrame,
       let candidateFrame = candidate.localFrame
    {
        let centerDistance = hypot(
            previousFrame.midX - candidateFrame.midX,
            previousFrame.midY - candidateFrame.midY
        )
        let sizeDistance = abs(previousFrame.width - candidateFrame.width)
            + abs(previousFrame.height - candidateFrame.height)
        let allowedCenterDistance = max(
            16,
            max(previousFrame.width, previousFrame.height) * 0.2
        )
        let allowedSizeDistance = max(
            20,
            (previousFrame.width + previousFrame.height) * 0.25
        )
        guard centerDistance <= allowedCenterDistance,
              sizeDistance <= allowedSizeDistance
        else {
            return nil
        }
        score += max(1, 100 - Int(centerDistance + sizeDistance))
    }

    if previous.role != nil, previous.role == candidate.role {
        score += 20
    }

    return score > 0 ? score : nil
}

public final class ComputerUseService {
    private var snapshotsByApp: [String: AppSnapshot] = [:]
    private let accessibilitySessions = AccessibilitySessionRegistry()
    /// Per-pid Codex-style focus enforcer. Session-scoped, never created per action.
    private var focusEnforcersByPID: [pid_t: SyntheticAppFocusEnforcer] = [:]
    /// Last clicked text-entry element per pid — see `rememberFocusableField`.
    private var lastClickedFieldByPID: [pid_t: AXUIElement] = [:]
    /// Last field we wrote `AXFocused = true` to, per pid.
    private var lastFocusedFieldByPID: [pid_t: AXUIElement] = [:]
    // [operon] The full rendered text from the previous get_app_state, cached per app, used for
    // the default diff output.
    private var lastRenderedByApp: [String: String] = [:]

    public init() {}

    /// Tear down synthetic background focus for every target. Call when the
    /// host session ends so targets stop believing they are active.
    public func endAllBackgroundFocusSessions() {
        for enforcer in focusEnforcersByPID.values {
            enforcer.deactivateFocusEnforcer()
        }
        focusEnforcersByPID.removeAll()
    }

    public func listApps() -> ToolCallResult {
        ToolCallResult.text(
            AppDiscovery.listCatalog()
                .map(\.renderedLine)
                .joined(separator: "\n")
        )
    }

    public func getAppState(
        app query: String,
        textLimit: SnapshotTextLimit = .defaults,
        treeLimits: AccessibilityTreeLimits = .defaults,
        disableDiff: Bool = false
    ) throws -> ToolCallResult {
        let key = query.lowercased()
        let previousFull = lastRenderedByApp[key]
        let snapshot = try refreshSnapshot(for: query, textLimit: textLimit, treeLimits: treeLimits)
        let fullText = snapshot.renderedText(style: .fullState)

        // Refresh the cache with the current snapshot's full rendering, stored under several alias
        // keys so the next diff can find it.
        let keys = Set([
            key,
            snapshot.app.name.lowercased(),
            (snapshot.app.bundleIdentifier ?? "").lowercased(),
        ].filter { !$0.isEmpty })
        for k in keys { lastRenderedByApp[k] = fullText }

        let bodyText = (disableDiff || previousFull == nil)
            ? fullText
            : Self.renderAccessibilityDiff(previous: previousFull!, current: fullText)

        var content = [ToolResultContentItem.text(bodyText)]
        if let screenshotImageData = snapshot.screenshotImageData {
            content.append(.jpegImage(screenshotImageData))
        }
        return ToolCallResult(content: content)
    }

    /// Wait for the controlled UI to become stable after an input action.
    ///
    /// A fixed 150 ms delay is too short for menus, navigation and Electron/SwiftUI
    /// rerenders. Keep a one-second minimum, then compare fresh AX + screenshot
    /// observations until two consecutive samples are equal. Visible loading
    /// indicators keep the wait alive, with a hard five-second ceiling.
    public func waitForUIToSettle(
        app query: String,
        minimumDelay: TimeInterval = 1.0,
        maximumDelay: TimeInterval = 5.0,
        pollingInterval: TimeInterval = 0.25
    ) {
        let startedAt = Date()

        if minimumDelay > 0 {
            Thread.sleep(forTimeInterval: minimumDelay)
        }

        var previous = settlingObservation(for: query)
        var consecutiveStableSamples = 0
        while Date().timeIntervalSince(startedAt) < maximumDelay {
            Thread.sleep(forTimeInterval: pollingInterval)
            guard let current = settlingObservation(for: query) else {
                previous = nil
                consecutiveStableSamples = 0
                continue
            }

            if current == previous && !current.appearsToBeLoading {
                consecutiveStableSamples += 1
                if consecutiveStableSamples >= 1 {
                    return
                }
            } else {
                consecutiveStableSamples = 0
            }
            previous = current
        }
    }

    private func settlingObservation(for query: String) -> UISettlingObservation? {
        guard let snapshot = try? refreshSnapshot(
            for: query,
            captureScreenshot: false,
            settleWebAccessibility: false
        ) else {
            return nil
        }
        let text = snapshot.renderedText(style: .fullState)
        let normalized = text.lowercased()
        let loadingMarkers = [
            "axprogressindicator",
            "progress indicator",
            " loading",
            "busy=true",
            "aria-busy",
        ]
        return UISettlingObservation(
            accessibilityText: text,
            appearsToBeLoading: loadingMarkers.contains { normalized.contains($0) },
            screenshotImageData: snapshot.screenshotImageData
        )
    }

    // [operon] Line-level diff of the AX tree: only changed lines are listed, indexed against the
    // current snapshot (both correct and cheaper in tokens;
    // it degrades gracefully towards a near-full listing when the structure changes a lot).
    // Reproduces the default diff semantics of codex's get_app_state (§11.7).
    public static func renderAccessibilityDiff(previous: String, current: String) -> String {
        let oldLines = previous.components(separatedBy: "\n")
        let newLines = current.components(separatedBy: "\n")
        let oldSet = Set(oldLines)
        let newSet = Set(newLines)
        let added = newLines.filter { !$0.isEmpty && !oldSet.contains($0) }
        let removed = oldLines.filter { !$0.isEmpty && !newSet.contains($0) }
        if added.isEmpty && removed.isEmpty {
            return "(no accessibility changes since the previous get_app_state; element_index values are still current)"
        }
        var out = "Accessibility diff since the previous get_app_state (only changed elements; the element_index values shown are current and safe to act on). Pass disableDiff:true for a full tree.\n"
        if !added.isEmpty { out += "\n[added/changed]\n" + added.joined(separator: "\n") }
        if !removed.isEmpty { out += "\n[removed]\n" + removed.joined(separator: "\n") }
        return out
    }

    public func click(app query: String, elementIndex: String?, x: Double?, y: Double?, clickCount: Int, mouseButton: String) throws -> ToolCallResult {
        let cachedSnapshot = try currentSnapshot(for: query)
        let button = MouseButtonKind(rawValue: mouseButton.lowercased()) ?? .left
        if cachedSnapshot.mode == .fixture {
            let cursorTarget: VisualCursorTarget?
            if let elementIndex {
                let record = try lookupElement(snapshot: cachedSnapshot, index: elementIndex)
                guard let identifier = record.identifier else {
                    throw ComputerUseError.invalidArguments("fixture click requires an identifier-backed element")
                }
                cursorTarget = visualCursorTarget(for: record, snapshot: cachedSnapshot)
                moveVisualCursor(to: cursorTarget)
                try FixtureBridge.post(FixtureCommand(kind: "click", identifier: identifier))
            } else if let x, let y {
                let identifier = try fixtureIdentifier(at: CGPoint(x: x, y: y), snapshot: cachedSnapshot)
                cursorTarget = fixtureVisualCursorTarget(identifier: identifier, snapshot: cachedSnapshot)
                moveVisualCursor(to: cursorTarget)
                try FixtureBridge.post(FixtureCommand(kind: "click", identifier: identifier, x: x, y: y))
            } else {
                throw ComputerUseError.invalidArguments("click requires either element_index or x/y")
            }

            Thread.sleep(forTimeInterval: 0.15)
            pulseVisualCursor(at: cursorTarget, clickCount: clickCount, mouseButton: button)
            return snapshotResult(for: try refreshSnapshot(for: query), style: .actionResult)
        }

        if let elementIndex {
            let (snapshot, record) = try prepareElementForInteraction(
                query: query,
                elementIndex: elementIndex,
                previousSnapshot: cachedSnapshot
            )
            guard let targetPoint = try globalClickPoint(for: record, snapshot: snapshot) else {
                throw ComputerUseError.stateUnavailable("element \(elementIndex) has no clickable frame")
            }
            let cursorTarget = makeVisualCursorTarget(
                at: targetPoint,
                targetWindowID: snapshot.targetWindowID,
                targetWindowLayer: snapshot.targetWindowLayer,
                windowBounds: snapshot.windowBounds
            )
            let insideWeb = record.element.map { hasAncestorRole("AXWebArea", of: $0) } ?? false

            // Codex `clickablePoint(scrollToVisible: true)` path scrolls first.
            scrollElementIntoViewIfNeeded(record.element)

            moveVisualCursor(to: cursorTarget)

            do {
                // How a reference element click behaves: clicking by element id
                // passes alwaysSimulateClick=false, and from there
                //   - alwaysSimulate, or a non-left button, uses a clickable point
                //     and a mouse event
                //   - not alwaysSimulate but inside a web view still uses a
                //     clickable point, never AXPress
                //   - not alwaysSimulate and not web uses either a virtual cursor
                //     press, or enforceActiveState followed by a mouse event
                //     posted to the pid
                // It never performs an accessibility action. An element click is
                // always a process-local mouse event.
                //
                // Operon maps clickablePoint + mouse → sendClickCodex
                // (MouseEventTarget, flipped for web). Do not AXPress web rows.
                _ = syntheticallyActivateIfNeededForSendingClick(
                    snapshot: snapshot,
                    isInsideWebView: insideWeb,
                    clickingByCoordinate: false,
                    element: record.element
                )

                let forceSimulate = alwaysSimulateClickEnabled()
                // Official: web always simulates; flag forces simulate for all.
                // Native without flag still ends in postToPid mouse in Codex —
                // we keep a short native AX attempt only as best-effort before
                // the same sendClick fallthrough (not used for web).
                if forceSimulate || insideWeb || button != .left {
                    debugClickDecision(
                        "sendClick alwaysSimulate=\(forceSimulate) insideWeb=\(insideWeb) button=\(button)"
                    )
                    try sendClickCodex(
                        at: targetPoint,
                        button: button,
                        clickCount: clickCount,
                        snapshot: snapshot,
                        insideWebView: insideWeb
                    )
                } else if try performAXClickSequence(
                    on: record,
                    snapshot: snapshot,
                    button: button,
                    clickCount: clickCount,
                    includeNearbyHitTesting: true,
                    allowActivationFallback: true
                ) {
                    // Native-only residual; Codex element click does not AXPress.
                    noteSynthesizedAction(for: snapshot)
                } else {
                    try sendClickCodex(
                        at: targetPoint,
                        button: button,
                        clickCount: clickCount,
                        snapshot: snapshot,
                        insideWebView: insideWeb
                    )
                }
            } catch {
                settleVisualCursor(at: cursorTarget)
                throw error
            }

            rememberFocusableField(record.element, pid: snapshot.app.pid)
            pulseVisualCursor(at: cursorTarget, clickCount: clickCount, mouseButton: button)
        } else if let x, let y {
            let snapshot = try prepareSnapshotForInteraction(
                query: query,
                previousSnapshot: cachedSnapshot
            )
            let screenshotPoint = CGPoint(x: x, y: y)
            let point = screenshotPixelToWindowPointInSnapshot(snapshot: snapshot, point: screenshotPoint)
            let targetPoint = try windowPointToGlobalPoint(snapshot: snapshot, point: point)
            let cursorTarget = makeVisualCursorTarget(
                at: targetPoint,
                targetWindowID: snapshot.targetWindowID,
                targetWindowLayer: snapshot.targetWindowLayer,
                windowBounds: snapshot.windowBounds
            )

            moveVisualCursor(to: cursorTarget)

            do {
                _ = syntheticallyActivateIfNeededForSendingClick(
                    snapshot: snapshot,
                    isInsideWebView: snapshot.containsWebArea,
                    clickingByCoordinate: true
                )

                // Coordinate clicks always simulate (Codex clickingByCoordinate path).
                if alwaysSimulateClickEnabled() || snapshot.containsWebArea {
                    try sendClickCodex(
                        at: targetPoint,
                        button: button,
                        clickCount: clickCount,
                        snapshot: snapshot,
                        insideWebView: snapshot.containsWebArea
                    )
                } else {
                    let candidates = try clickCandidates(at: point, in: snapshot)
                    var handled = false
                    for record in candidates {
                        if try performAXClickSequence(
                            on: record,
                            snapshot: snapshot,
                            button: button,
                            clickCount: clickCount,
                            includeNearbyHitTesting: false,
                            allowActivationFallback: false
                        ) {
                            handled = true
                            noteSynthesizedAction(for: snapshot)
                            break
                        }
                    }
                    if !handled {
                        try sendClickCodex(
                            at: targetPoint,
                            button: button,
                            clickCount: clickCount,
                            snapshot: snapshot,
                            insideWebView: false
                        )
                    }
                }
            } catch {
                settleVisualCursor(at: cursorTarget)
                throw error
            }

            rememberFocusableField((try? clickCandidates(at: point, in: snapshot))?.first?.element, pid: snapshot.app.pid)
            pulseVisualCursor(at: cursorTarget, clickCount: clickCount, mouseButton: button)
        } else {
            throw ComputerUseError.invalidArguments("click requires either element_index or x/y")
        }

        return snapshotResult(for: try refreshSnapshot(for: query), style: .actionResult)
    }

    public func performSecondaryAction(app query: String, elementIndex: String, action: String) throws -> ToolCallResult {
        let cachedSnapshot = try currentSnapshot(for: query)
        let cachedRecord = try lookupElement(snapshot: cachedSnapshot, index: elementIndex)

        if cachedSnapshot.mode == .fixture {
            guard action.caseInsensitiveCompare("Raise") == .orderedSame else {
                throw ComputerUseError.message(invalidSecondaryActionMessage(action: action, record: cachedRecord))
            }

            return snapshotResult(for: try refreshSnapshot(for: query), style: .actionResult)
        }

        // Codex: prepareToInteract (synthetic focus enforcer) then
        // UIElement.perform(action). Raise/AXRaise is a normal secondary action
        // when the tree advertises it — no special case path.
        let (snapshot, record) = try prepareElementForInteraction(
            query: query,
            elementIndex: elementIndex,
            previousSnapshot: cachedSnapshot
        )
        guard let rawAction = matchingAction(requested: action, record: record) else {
            throw ComputerUseError.message(invalidSecondaryActionMessage(action: action, record: record))
        }

        guard let element = record.element else {
            throw ComputerUseError.stateUnavailable("element \(elementIndex) has no backing accessibility object")
        }

        let result = AXUIElementPerformAction(element, rawAction as CFString)
        guard result == .success else {
            throw ComputerUseError.message("AXUIElementPerformAction failed with \(result.rawValue)")
        }

        noteSynthesizedAction(for: snapshot)
        Thread.sleep(forTimeInterval: 0.15)
        return snapshotResult(for: try refreshSnapshot(for: query), style: .actionResult)
    }

    public func scroll(app query: String, direction: String, elementIndex: String, pages: Double) throws -> ToolCallResult {
        let normalized = direction.lowercased()
        guard ["up", "down", "left", "right"].contains(normalized) else {
            throw ComputerUseError.message("Invalid scroll direction: \(direction)")
        }
        guard pages.isFinite, pages > 0 else {
            throw ComputerUseError.message("pages must be > 0")
        }

        let cachedSnapshot = try currentSnapshot(for: query)
        let cachedRecord = try lookupElement(snapshot: cachedSnapshot, index: elementIndex)

        if cachedSnapshot.mode == .fixture {
            guard let identifier = cachedRecord.identifier else {
                throw ComputerUseError.invalidArguments("fixture scroll requires an identifier-backed element")
            }
            try FixtureBridge.post(FixtureCommand(kind: "scroll", identifier: identifier, direction: normalized, pages: pages))
            Thread.sleep(forTimeInterval: 0.15)
            return snapshotResult(for: try refreshSnapshot(for: query), style: .actionResult)
        }

        let (snapshot, record) = try prepareElementForInteraction(
            query: query,
            elementIndex: elementIndex,
            previousSnapshot: cachedSnapshot
        )
        // Official `ComputerUseAppController.scroll(deltaX:deltaY:)` has no AX
        // branch at all: it resolves a MouseEventTarget and posts a wheel event.
        // `AXScroll<Direction>ByPage` stays reachable through
        // `perform_secondary_action`, which is where official exposes it — using
        // it here silently did nothing on AppKit scroll views.
        if let point = try globalPoint(for: record, snapshot: snapshot) {
            try performScrollEvent(
                at: point,
                direction: normalized,
                pages: pages,
                targetDescription: "element_index=\(elementIndex)",
                snapshot: snapshot
            )
        } else if let repeatCount = integralScrollPageCount(pages),
                  let rawAction = record.rawActions.first(where: { $0.caseInsensitiveCompare("AXScroll\(normalized.capitalized)ByPage") == .orderedSame }),
                  let element = record.element {
            for _ in 0..<repeatCount {
                _ = AXUIElementPerformAction(element, rawAction as CFString)
                Thread.sleep(forTimeInterval: 0.05)
            }
        } else {
            throw ComputerUseError.stateUnavailable("element \(elementIndex) has no scrollable frame")
        }

        return snapshotResult(for: try refreshSnapshot(for: query), style: .actionResult)
    }

    public func drag(app query: String, fromX: Double, fromY: Double, toX: Double, toY: Double) throws -> ToolCallResult {
        let cachedSnapshot = try currentSnapshot(for: query)
        if cachedSnapshot.mode == .fixture {
            try FixtureBridge.post(FixtureCommand(kind: "drag", identifier: "fixture-drag-pad", x: fromX, y: fromY, toX: toX, toY: toY))
            Thread.sleep(forTimeInterval: 0.15)
            return snapshotResult(for: try refreshSnapshot(for: query), style: .actionResult)
        }

        let snapshot = try prepareSnapshotForInteraction(
            query: query,
            previousSnapshot: cachedSnapshot
        )
        let start = try screenshotToGlobalPoint(snapshot: snapshot, x: fromX, y: fromY)
        let end = try screenshotToGlobalPoint(snapshot: snapshot, x: toX, y: toY)
        try performDragEvent(
            from: start,
            to: end,
            targetDescription: "from=(\(Int(fromX)), \(Int(fromY))) to=(\(Int(toX)), \(Int(toY)))",
            snapshot: snapshot
        )
        return snapshotResult(for: try refreshSnapshot(for: query), style: .actionResult)
    }

    public func typeText(app query: String, text: String) throws -> ToolCallResult {
        let cachedSnapshot = try currentSnapshot(for: query)
        if cachedSnapshot.mode == .fixture {
            try FixtureBridge.post(FixtureCommand(kind: "type_text", identifier: "fixture-input", value: text))
            Thread.sleep(forTimeInterval: 0.15)
            return snapshotResult(for: try refreshSnapshot(for: query), style: .actionResult)
        }

        let snapshot = try prepareSnapshotForInteraction(
            query: query,
            previousSnapshot: cachedSnapshot
        )
        _ = syntheticallyActivateIfNeededForSendingClick(
            snapshot: snapshot,
            isInsideWebView: snapshot.containsWebArea,
            clickingByCoordinate: false
        )
        // The snapshot was captured before this focus write, so its
        // `focusedElement` is still the app's stale value — type into the field
        // the click actually targeted.
        let clickedField = lastClickedFieldByPID[snapshot.app.pid]
        if try typeTextBySettingFocusedValueIfAvailable(
            text,
            into: clickedField ?? snapshot.focusedElement
        ) {
            Thread.sleep(forTimeInterval: 0.1)
            noteSynthesizedAction(for: snapshot)
            return snapshotResult(for: try refreshSnapshot(for: query), style: .actionResult)
        }

        guard try canTypeTextUsingKeyboardFallback(
            element: clickedField ?? snapshot.focusedElement
        ) else {
            throw ComputerUseError.stateUnavailable("type_text requires a focused editable text element. Click a text entry area first, or use set_value on a settable text element.")
        }

        focusFieldIfNeeded(clickedField, snapshot: snapshot)
        try InputSimulation.typeText(text, pid: snapshot.app.pid)
        noteSynthesizedAction(for: snapshot)
        return snapshotResult(for: try refreshSnapshot(for: query), style: .actionResult)
    }

    public func pressKey(app query: String, key: String) throws -> ToolCallResult {
        let cachedSnapshot = try currentSnapshot(for: query)
        if cachedSnapshot.mode == .fixture {
            try FixtureBridge.post(FixtureCommand(kind: "press_key", identifier: "fixture-key-capture", value: key))
            Thread.sleep(forTimeInterval: 0.15)
            return snapshotResult(for: try refreshSnapshot(for: query), style: .actionResult)
        }

        let snapshot = try prepareSnapshotForInteraction(
            query: query,
            previousSnapshot: cachedSnapshot
        )
        _ = syntheticallyActivateIfNeededForSendingClick(
            snapshot: snapshot,
            isInsideWebView: snapshot.containsWebArea,
            clickingByCoordinate: false
        )
        focusFieldIfNeeded(lastClickedFieldByPID[snapshot.app.pid], snapshot: snapshot)
        try InputSimulation.pressKey(key, pid: snapshot.app.pid)
        noteSynthesizedAction(for: snapshot)
        return snapshotResult(for: try refreshSnapshot(for: query), style: .actionResult)
    }

    public func setValue(app query: String, elementIndex: String, value: String) throws -> ToolCallResult {
        let cachedSnapshot = try currentSnapshot(for: query)
        let cachedRecord = try lookupElement(snapshot: cachedSnapshot, index: elementIndex)

        if cachedSnapshot.mode == .fixture {
            guard let identifier = cachedRecord.identifier else {
                throw ComputerUseError.invalidArguments("fixture set_value requires a known element identifier")
            }

            let cursorTarget = visualCursorTarget(for: cachedRecord, snapshot: cachedSnapshot)
            moveVisualCursor(to: cursorTarget)
            try FixtureBridge.post(FixtureCommand(kind: "set_value", identifier: identifier, value: value))
            Thread.sleep(forTimeInterval: 0.15)
            settleVisualCursor(at: cursorTarget)
            return snapshotResult(for: try refreshSnapshot(for: query), style: .actionResult)
        }

        let (snapshot, record) = try prepareElementForInteraction(
            query: query,
            elementIndex: elementIndex,
            previousSnapshot: cachedSnapshot
        )
        guard let element = record.element else {
            throw ComputerUseError.stateUnavailable("element \(elementIndex) has no backing accessibility object")
        }

        guard try isSettableForSetValue(element: element, attribute: kAXValueAttribute) else {
            throw ComputerUseError.message(nonSettableSetValueErrorMessage)
        }

        let cursorTarget = visualCursorTarget(for: record, snapshot: snapshot)
        moveVisualCursor(to: cursorTarget)

        do {
            if shouldAutosubmitSearchField(element: element, record: record) {
                // Focus before writing, like a real user: a background click
                // never moved AppKit's firstResponder, so without this both the
                // value and the Return can land on whichever field still holds
                // key focus from an earlier action.
                focusFieldIfNeeded(element, snapshot: snapshot)
            }
            let result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString)
            guard result == .success else {
                throw ComputerUseError.message("AXUIElementSetAttributeValue failed with \(result.rawValue)")
            }

            Thread.sleep(forTimeInterval: 0.1)
            // Codex `autosubmitSearchFields` (default true in practice for
            // search-like fields): press Return so filters apply without a
            // second agent step.
            if shouldAutosubmitSearchField(element: element, record: record) {
                try InputSimulation.pressKey("Return", pid: snapshot.app.pid)
                Thread.sleep(forTimeInterval: 0.15)
            }
        } catch {
            settleVisualCursor(at: cursorTarget)
            throw error
        }

        settleVisualCursor(at: cursorTarget)
        noteSynthesizedAction(for: snapshot)
        return snapshotResult(for: try refreshSnapshot(for: query), style: .actionResult)
    }

    /// Codex setValue `autosubmitSearchFields` heuristic.
    private func shouldAutosubmitSearchField(element: AXUIElement, record: ElementRecord) -> Bool {
        let role = stringValue(of: element, attribute: kAXRoleAttribute) ?? record.role ?? ""
        let roleDescription = (
            stringValue(of: element, attribute: kAXRoleDescriptionAttribute) ?? ""
        ).lowercased()
        let title = (
            stringValue(of: element, attribute: kAXTitleAttribute)
                ?? stringValue(of: element, attribute: kAXDescriptionAttribute)
                ?? record.title
                ?? ""
        ).lowercased()
        let placeholder = (
            stringValue(of: element, attribute: "AXPlaceholderValue") ?? ""
        ).lowercased()
        let isTextField =
            role == kAXTextFieldRole as String
            || roleDescription.contains("search")
            || roleDescription.contains("text field")
        let looksLikeSearch =
            title.contains("search")
            || title.contains("搜索")
            || placeholder.contains("search")
            || placeholder.contains("搜索")
            || roleDescription.contains("search")
        return isTextField && looksLikeSearch
    }

    // [operon] select_text — present in the codex Window API but absent upstream. Selects the
    // matching text inside an editable element.
    public func selectText(
        app query: String,
        elementIndex: String,
        text: String,
        prefix: String?,
        suffix: String?,
        selection: String
    ) throws -> ToolCallResult {
        let cachedSnapshot = try currentSnapshot(for: query)
        let (snapshot, record): (AppSnapshot, ElementRecord)
        if cachedSnapshot.mode == .fixture {
            snapshot = cachedSnapshot
            record = try lookupElement(snapshot: cachedSnapshot, index: elementIndex)
        } else {
            (snapshot, record) = try prepareElementForInteraction(
                query: query,
                elementIndex: elementIndex,
                previousSnapshot: cachedSnapshot
            )
        }
        guard let element = record.element else {
            throw ComputerUseError.stateUnavailable("element \(elementIndex) has no backing accessibility object")
        }

        var valueRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &valueRef) == .success,
              let full = valueRef as? String
        else {
            throw ComputerUseError.stateUnavailable("element \(elementIndex) has no readable text value")
        }

        // AX selections use UTF-16 offsets, and NSString is UTF-16 natively. prefix/suffix
        // disambiguate which occurrence is meant.
        let ns = full as NSString
        let needle = (prefix ?? "") + text + (suffix ?? "")
        let found = ns.range(of: needle)
        guard found.location != NSNotFound else {
            throw ComputerUseError.invalidArguments("could not find text '\(text)' in element \(elementIndex)")
        }
        let start = found.location + ((prefix ?? "") as NSString).length
        let length = (text as NSString).length
        var cfRange: CFRange
        switch selection {
        case "cursor_before": cfRange = CFRange(location: start, length: 0)
        case "cursor_after": cfRange = CFRange(location: start + length, length: 0)
        default: cfRange = CFRange(location: start, length: length) // "text"
        }
        guard let axRange = AXValueCreate(.cfRange, &cfRange) else {
            throw ComputerUseError.message("failed to create AXValue range for selection")
        }

        let cursorTarget = visualCursorTarget(for: record, snapshot: snapshot)
        moveVisualCursor(to: cursorTarget)
        let result = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, axRange)
        settleVisualCursor(at: cursorTarget)
        guard result == .success else {
            throw ComputerUseError.message("AXUIElementSetAttributeValue(kAXSelectedTextRange) failed with \(result.rawValue)")
        }

        return snapshotResult(for: try refreshSnapshot(for: query), style: .actionResult)
    }

    private func currentSnapshot(for query: String) throws -> AppSnapshot {
        if let snapshot = snapshotsByApp[query.lowercased()] {
            return snapshot
        }

        return try refreshSnapshot(for: query)
    }

    private func prepareSnapshotForInteraction(
        query: String,
        previousSnapshot: AppSnapshot
    ) throws -> AppSnapshot {
        ComputerUseTrace.mark("prepareSnapshotForInteraction BEGIN")
        defer { ComputerUseTrace.mark("prepareSnapshotForInteraction END") }

        // Codex prepareToInteract: session-sticky SyntheticAppFocusEnforcer only.
        // Read path never does this; interact path does.
        let decision = ComputerUseTrace.measure("enforceBackgroundFocus") {
            enforceBackgroundFocus(for: previousSnapshot)
        }
        if !decision.isNoOp {
            Thread.sleep(forTimeInterval: 0.05)
        }
        return try refreshSnapshot(
            for: query,
            captureScreenshot: false,
            settleWebAccessibility: false
        )
    }

    /// Long-lived per-pid enforcer (Codex `SyntheticAppFocusEnforcer`).
    private func focusEnforcer(for app: RunningAppDescriptor) -> SyntheticAppFocusEnforcer {
        focusEnforcersByPID = focusEnforcersByPID.filter { pid, enforcer in
            let alive = NSRunningApplication(processIdentifier: pid)?.isTerminated == false
            if !alive {
                enforcer.deactivateFocusEnforcer()
            }
            return alive
        }
        if let existing = focusEnforcersByPID[app.pid] {
            return existing
        }
        let enforcer = SyntheticAppFocusEnforcer(pid: app.pid)
        focusEnforcersByPID[app.pid] = enforcer
        return enforcer
    }

    @discardableResult
    private func enforceBackgroundFocus(for snapshot: AppSnapshot) -> FocusEnforcementDecision {
        focusEnforcer(for: snapshot.app).enforceActiveState(
            windowID: snapshot.targetWindowID ?? 0,
            windowBounds: snapshot.windowBounds
        )
    }

    private func noteSynthesizedAction(for snapshot: AppSnapshot) {
        focusEnforcer(for: snapshot.app).synthesizedActionWasPerformed()
    }

    private func prepareElementForInteraction(
        query: String,
        elementIndex: String,
        previousSnapshot: AppSnapshot
    ) throws -> (snapshot: AppSnapshot, record: ElementRecord) {
        let previousRecord = try lookupElement(
            snapshot: previousSnapshot,
            index: elementIndex
        )
        let refreshedSnapshot = try prepareSnapshotForInteraction(
            query: query,
            previousSnapshot: previousSnapshot
        )
        guard let refreshedRecord = refetchedRecord(
            previousRecord,
            in: refreshedSnapshot
        ) else {
            throw ComputerUseError.stateUnavailable(
                "The UI changed before element \(elementIndex) could be used. Call get_app_state and retry with a current element_index."
            )
        }
        return (refreshedSnapshot, refreshedRecord)
    }

    private func refetchedRecord(
        _ previous: ElementRecord,
        in snapshot: AppSnapshot
    ) -> ElementRecord? {
        if let previousElement = previous.element,
           let exact = snapshot.elements.values.first(where: {
               sameElement(previousElement, $0.element)
           })
        {
            return exact
        }

        let previousIdentity = accessibilityIdentity(for: previous)
        let ranked = snapshot.elements.values.compactMap { candidate -> (ElementRecord, Int)? in
            guard let score = accessibilityElementRefetchScore(
                previous: previousIdentity,
                candidate: accessibilityIdentity(for: candidate)
            ) else {
                return nil
            }
            return (candidate, score)
        }
        .sorted { lhs, rhs in
            if lhs.1 != rhs.1 {
                return lhs.1 > rhs.1
            }
            return lhs.0.index < rhs.0.index
        }

        if let best = ranked.first,
           ranked.dropFirst().first?.1 != best.1
        {
            return best.0
        }

        guard let previousElement = previous.element,
              stringValue(
                  of: previousElement,
                  attribute: kAXRoleAttribute
              ) != nil
        else {
            return nil
        }

        let actions = copyActions(for: previousElement) ?? previous.rawActions
        return ElementRecord(
            index: previous.index,
            identifier: previous.identifier,
            element: previousElement,
            localFrame: localFrame(
                of: previousElement,
                windowBounds: snapshot.windowBounds
            ),
            rawActions: actions,
            prettyActions: actions,
            isSyntheticText: previous.isSyntheticText,
            role: previous.role,
            title: previous.title
        )
    }

    private func accessibilityIdentity(
        for record: ElementRecord
    ) -> AccessibilityElementIdentity {
        AccessibilityElementIdentity(
            identifier: record.identifier,
            role: record.role,
            title: record.title,
            localFrame: record.localFrame,
            isSyntheticText: record.isSyntheticText
        )
    }

    @discardableResult
    private func refreshSnapshot(
        for query: String,
        textLimit: SnapshotTextLimit = .defaults,
        treeLimits: AccessibilityTreeLimits = .defaults,
        captureScreenshot: Bool = true,
        settleWebAccessibility: Bool = true
    ) throws -> AppSnapshot {
        let app = try AppDiscovery.resolve(query)

        // Codex get_app_state / skyshot read path: no SyntheticAppFocusEnforcer.
        // Interaction prepares focus via prepareSnapshotForInteraction only.
        let snapshot: AppSnapshot
        if app.name == FixtureBridge.appName {
            snapshot = try SnapshotBuilder.build(
                for: app,
                textLimit: textLimit,
                treeLimits: treeLimits,
                captureScreenshot: captureScreenshot,
                settleWebAccessibility: settleWebAccessibility
            )
        } else {
            let session = accessibilitySessions.session(for: app)
            snapshot = try buildSnapshotRetryingTransientWindowChanges(
                app: app,
                session: session,
                textLimit: textLimit,
                treeLimits: treeLimits,
                captureScreenshot: captureScreenshot,
                settleWebAccessibility: settleWebAccessibility
            )
        }

        let keys = Set([
            query.lowercased(),
            app.name.lowercased(),
            (app.bundleIdentifier ?? "").lowercased(),
        ].filter { !$0.isEmpty })

        for key in keys {
            snapshotsByApp[key] = snapshot
        }

        return snapshot
    }

    private func buildSnapshotRetryingTransientWindowChanges(
        app: RunningAppDescriptor,
        session: AccessibilitySession,
        textLimit: SnapshotTextLimit,
        treeLimits: AccessibilityTreeLimits,
        captureScreenshot: Bool,
        settleWebAccessibility: Bool
    ) throws -> AppSnapshot {
        let maximumAttempts = 6
        for attempt in 0..<maximumAttempts {
            do {
                return try SnapshotBuilder.build(
                    for: app,
                    session: session,
                    textLimit: textLimit,
                    treeLimits: treeLimits,
                    captureScreenshot: captureScreenshot,
                    settleWebAccessibility: settleWebAccessibility
                )
            } catch ComputerUseError.stateUnavailable(let message)
                where message == computerUseNoWindowFoundMessage
                    && attempt < maximumAttempts - 1
            {
                session.markInvalidated()
                Thread.sleep(forTimeInterval: 0.15 + Double(attempt) * 0.05)
            }
        }

        throw ComputerUseError.stateUnavailable(computerUseNoWindowFoundMessage)
    }

    private func lookupElement(snapshot: AppSnapshot, index: String) throws -> ElementRecord {
        guard let parsedIndex = Int(index), let record = snapshot.elements[parsedIndex] else {
            throw ComputerUseError.invalidArguments("unknown element_index '\(index)'")
        }

        return record
    }

    private func matchingAction(requested: String, record: ElementRecord) -> String? {
        if let exact = record.rawActions.first(where: { $0.caseInsensitiveCompare(requested) == .orderedSame }) {
            return exact
        }

        if let pretty = zip(record.rawActions, record.prettyActions).first(where: { $0.1.caseInsensitiveCompare(requested) == .orderedSame }) {
            return pretty.0
        }

        return nil
    }

    private func invalidSecondaryActionMessage(action: String, record: ElementRecord) -> String {
        invalidSecondaryActionErrorMessage(action: action, elementIndex: record.index)
    }

    private func performPreferredClick(on record: ElementRecord, button: MouseButtonKind, clickCount: Int) throws -> Bool {
        guard let element = record.element else {
            return false
        }

        switch button {
        case .left:
            if clickCount <= 1,
               !hasAncestorRole("AXWebArea", of: element),
               try selectContainingListItem(for: element)
            {
                return true
            }

            if try performAction(named: kAXPressAction as String, on: element, availableActions: record.rawActions, repeatCount: clickCount) {
                return true
            }

            if try performAction(named: kAXConfirmAction as String, on: element, availableActions: record.rawActions, repeatCount: clickCount) {
                return true
            }

            if try performAction(named: "AXOpen", on: element, availableActions: record.rawActions, repeatCount: clickCount) {
                return true
            }
        case .right:
            if try performAction(named: kAXShowMenuAction as String, on: element, availableActions: record.rawActions, repeatCount: clickCount) {
                return true
            }
        case .middle:
            break
        }

        return false
    }

    private func clickCandidates(at point: CGPoint, in snapshot: AppSnapshot) throws -> [ElementRecord] {
        var candidates: [ElementRecord] = []

        if let bestRecord = bestElement(containing: point, in: snapshot) {
            candidates.append(bestRecord)
        }

        if let hitRecord = try hitTestElement(at: point, in: snapshot) {
            candidates.append(hitRecord)
        }

        return candidates.reduce(into: []) { uniqueCandidates, candidate in
            if !uniqueCandidates.contains(where: { sameElement($0.element, candidate.element) }) {
                uniqueCandidates.append(candidate)
            }
        }
    }

    private func sameElement(_ lhs: AXUIElement?, _ rhs: AXUIElement?) -> Bool {
        guard let lhs, let rhs else {
            return false
        }

        return CFEqual(lhs, rhs)
    }

    private func selectContainingListItem(for element: AXUIElement) throws -> Bool {
        guard let target = selectableListItem(containing: element) else {
            return false
        }

        let result = AXUIElementSetAttributeValue(
            target.list,
            kAXSelectedChildrenAttribute as CFString,
            [target.item] as CFArray
        )

        switch result {
        case .success:
            Thread.sleep(forTimeInterval: 0.15)
            return true
        case .failure, .attributeUnsupported, .actionUnsupported, .cannotComplete, .noValue, .invalidUIElement, .illegalArgument:
            return false
        default:
            throw ComputerUseError.message("AXUIElementSetAttributeValue(\(kAXSelectedChildrenAttribute)) failed with \(result.rawValue)")
        }
    }

    private func selectableListItem(containing element: AXUIElement) -> (list: AXUIElement, item: AXUIElement)? {
        var current = element
        var directChild = element

        for _ in 0..<8 {
            guard let parent = copyParent(of: current) else {
                return nil
            }

            if stringValue(of: parent, attribute: kAXRoleAttribute) == kAXListRole as String,
               isSettable(element: parent, attribute: kAXSelectedChildrenAttribute)
            {
                return (parent, directChild)
            }

            directChild = parent
            current = parent
        }

        return nil
    }

    /// Codex `syntheticallyActivateIfNeededForSendingClick`.
    ///
    /// Pure gate (`ClickActivationGate`) decides; we only post when it says so.
    @discardableResult
    private func syntheticallyActivateIfNeededForSendingClick(
        snapshot: AppSnapshot,
        isInsideWebView: Bool,
        clickingByCoordinate: Bool,
        element: AXUIElement? = nil
    ) -> Bool {
        let windowID = snapshot.targetWindowID ?? 0
        let bounds = snapshot.windowBounds
        let enforcer = focusEnforcer(for: snapshot.app)
        let selection = element.map { clickingMayCauseSelection(element: $0) } ?? false
        let catalyst = isCatalystApp(
            bundleIdentifier: snapshot.app.bundleIdentifier,
            appPath: nil
        )
        // Prefer the snapshot root window if we still hold a focused AX window
        // on the live app element.
        let focusedEqual = targetWindowIsFocusedWindow(
            appPID: snapshot.app.pid,
            candidate: accessibilitySessions.session(for: snapshot.app).recoverWindowFromCGWindow()
                ?? preferredFocusedWindowElement(for: snapshot.app.pid)
        )

        let gate = ClickActivationGate.decide(
            enforcerState: enforcer.currentState,
            isCatalystApp: catalyst,
            isInsideWebView: isInsideWebView,
            clickingByCoordinate: clickingByCoordinate,
            clickingMayCauseSelection: selection,
            targetWindowIsFocusedWindow: focusedEqual
        )
        guard gate.shouldActivate else {
            return false
        }

        let decision: FocusEnforcementDecision
        if gate.shouldReassert {
            decision = enforcer.reassertActiveState(
                windowID: windowID,
                windowBounds: bounds
            )
        } else {
            decision = enforcer.enforceActiveState(
                windowID: windowID,
                windowBounds: bounds
            )
        }
        // Codex `sendClick` always follows enforce with
        // `waitUntilAppBelievesItIsFrontmost(timeout: 2.0)` before mouse posts.
        if !decision.isNoOp || isInsideWebView || clickingByCoordinate {
            enforcer.waitUntilAppBelievesItIsFrontmost(timeout: 2.0)
        }
        return !decision.isNoOp
    }

    /// Codex `clickablePoint(scrollToVisible:)` — scroll the target into view
    /// before computing a click point when `AXScrollToVisible` is advertised.
    private func scrollElementIntoViewIfNeeded(_ element: AXUIElement?) {
        guard let element else {
            return
        }
        var current: AXUIElement? = element
        for _ in 0..<8 {
            guard let node = current else {
                return
            }
            let actions = copyActions(for: node) ?? []
            if actions.contains(where: {
                $0.caseInsensitiveCompare("AXScrollToVisible") == .orderedSame
            }) {
                _ = AXUIElementPerformAction(node, "AXScrollToVisible" as CFString)
                Thread.sleep(forTimeInterval: 0.05)
                return
            }
            current = copyParent(of: node)
        }
    }

    private func preferredFocusedWindowElement(for pid: pid_t) -> AXUIElement? {
        let app = AXUIElementCreateApplication(pid)
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            app,
            kAXFocusedWindowAttribute as CFString,
            &focused
        ) == .success,
        let focused,
        CFGetTypeID(focused) == AXUIElementGetTypeID()
        else {
            return nil
        }
        return (focused as! AXUIElement)
    }

    /// Codex feature flag `computerUseAlwaysSimulateClick` (env override).
    private func alwaysSimulateClickEnabled() -> Bool {
        guard let raw = ProcessInfo.processInfo.environment["OPEN_COMPUTER_USE_ALWAYS_SIMULATE_CLICK"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        else {
            return false
        }
        return ["1", "true", "yes", "on"].contains(raw)
    }

    /// Build a Codex `MouseEventTarget` for this snapshot.
    private func mouseEventTarget(
        for snapshot: AppSnapshot,
        insideWebView: Bool
    ) -> MouseEventTarget? {
        guard
            let windowID = snapshot.targetWindowID,
            windowID != 0,
            let bounds = snapshot.windowBounds,
            bounds.width > 1,
            bounds.height > 1
        else {
            return nil
        }
        // Electron / web content is flipped (top-left local Y). Classic AppKit
        // windows use bottom-left unless the content view is flipped.
        return MouseEventTarget(
            pid: snapshot.app.pid,
            windowID: windowID,
            windowBounds: bounds,
            windowUsesFlippedCoordinates: insideWebView || snapshot.containsWebArea
        )
    }

    /// Codex `sendClick` — process-local pointer with flipped-aware local coords.
    /// The last field a click landed on, per target pid. A background click
    /// does not move AppKit's firstResponder, so this is the only record of
    /// where the user asked the keyboard to go.
    private func rememberFocusableField(_ element: AXUIElement?, pid: pid_t) {
        guard let element, isFocusableField(element) else {
            return
        }
        lastClickedFieldByPID[pid] = element
    }

    private func isFocusableField(_ element: AXUIElement) -> Bool {
        // Official `isFocusableField` is a text-entry predicate,
        // not "anything with a settable AXFocused". Focusing buttons and other
        // controls would move keyboard focus away from where typing should land.
        let focusableRoles: Set<String> = [
            kAXTextFieldRole as String,
            kAXTextAreaRole as String,
            kAXComboBoxRole as String,
            "AXSearchField",
            "AXTextView"
        ]
        guard
            let role = stringValue(of: element, attribute: kAXRoleAttribute),
            focusableRoles.contains(role)
        else {
            return false
        }
        var settable = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(element, kAXFocusedAttribute as CFString, &settable) == .success
            && settable.boolValue
    }

    /// Codex `UIElementProtocol.focusFieldIfNeeded(in:app:focusEnforcer:)`
    /// → `focus(in:app:focusEnforcer:)`.
    ///
    /// Official never relies on a click to move keyboard focus: it checks
    /// `isFocusableField`, enforces the synthetic active state, then writes the
    /// AX attribute. A background click does not change AppKit's firstResponder,
    /// so without this step `type_text` lands on whatever stale element the app
    /// still reports as `AXFocusedUIElement`.
    @discardableResult
    private func focusFieldIfNeeded(
        _ element: AXUIElement?,
        snapshot: AppSnapshot
    ) -> Bool {
        guard let element, isFocusableField(element) else {
            return false
        }
        // No "already focused?" early-out: AX can report a field as focused while
        // AppKit's firstResponder is elsewhere (a background click never moved
        // it), and skipping the write on that stale read leaves the next key
        // event going to the wrong field.
        enforceBackgroundFocus(for: snapshot)
        // Release the field we focused last. AppKit will not hand the field
        // editor to a new field while the old one is still editing, and the
        // stale one then keeps receiving the key events.
        if let previous = lastFocusedFieldByPID[snapshot.app.pid],
           CFEqual(previous, element) == false
        {
            AXUIElementSetAttributeValue(previous, kAXFocusedAttribute as CFString, kCFBooleanFalse)
            Thread.sleep(forTimeInterval: 0.05)
        }
        lastFocusedFieldByPID[snapshot.app.pid] = element
        let result = AXUIElementSetAttributeValue(
            element,
            kAXFocusedAttribute as CFString,
            kCFBooleanTrue
        )
        return result == .success
    }

    private func sendClickCodex(
        at globalPoint: CGPoint,
        button: MouseButtonKind,
        clickCount: Int,
        snapshot: AppSnapshot,
        insideWebView: Bool
    ) throws {
        let eventPoint = inputEventPoint(fromScreenStatePoint: globalPoint)
        if let target = mouseEventTarget(for: snapshot, insideWebView: insideWebView) {
            debugClickDecision(
                "sendClick pid=\(target.pid) window=\(target.windowID) flipped=\(target.windowUsesFlippedCoordinates) x=\(Int(eventPoint.x)) y=\(Int(eventPoint.y))"
            )
            try InputSimulation.sendClick(
                to: target,
                at: eventPoint,
                button: button,
                clickCount: clickCount
            )
            noteSynthesizedAction(for: snapshot)
            return
        }
        // Fallback when CG window binding is missing.
        try InputSimulation.clickTargeted(
            at: eventPoint,
            button: button,
            clickCount: clickCount,
            pid: snapshot.app.pid,
            windowID: snapshot.targetWindowID,
            windowBounds: snapshot.windowBounds,
            windowUsesFlippedCoordinates: insideWebView || snapshot.containsWebArea
        )
        noteSynthesizedAction(for: snapshot)
    }

    private func performAXClickSequence(
        on record: ElementRecord,
        snapshot: AppSnapshot,
        button: MouseButtonKind,
        clickCount: Int,
        includeNearbyHitTesting: Bool,
        allowActivationFallback: Bool
    ) throws -> Bool {
        // Caller already skipped web via alwaysSimulate / insideWeb. Keep a
        // hard guard so AXPress is never trusted for AXWebArea descendants.
        if let element = record.element, hasAncestorRole("AXWebArea", of: element) {
            debugClickDecision("inside web view — refuse AXPress false success")
            return false
        }

        let preferContainingWebRowAXClick = shouldPreferContainingWebRowAXClick(record, in: snapshot)
        debugClickDecision("record=\(clickDebugDescription(record)) preferContainingWebRowAXClick=\(preferContainingWebRowAXClick)")

        if preferContainingWebRowAXClick,
           try performContainingWebRowClick(for: record, snapshot: snapshot, button: button, clickCount: clickCount)
        {
            Thread.sleep(forTimeInterval: 0.15)
            return true
        }

        if !preferContainingWebRowAXClick {
            if try performPreferredClick(on: record, button: button, clickCount: clickCount) {
                debugClickDecision("handled by preferred target \(clickDebugDescription(record))")
                Thread.sleep(forTimeInterval: 0.15)
                return true
            }

            for candidate in descendantClickCandidates(for: record, snapshot: snapshot) {
                if try performPreferredClick(on: candidate, button: button, clickCount: clickCount) {
                    debugClickDecision("handled by descendant \(clickDebugDescription(candidate))")
                    Thread.sleep(forTimeInterval: 0.15)
                    return true
                }
            }

            if includeNearbyHitTesting {
                for localPoint in clickActionPoints(for: record, snapshot: snapshot) {
                    guard let hitRecord = try hitTestElement(at: localPoint, in: snapshot) ?? bestElement(containing: localPoint, in: snapshot) else {
                        continue
                    }

                    if !isLikelySyntheticSideAction(hitRecord, in: record),
                       try performPreferredClick(on: hitRecord, button: button, clickCount: clickCount)
                    {
                        debugClickDecision("handled by hit record \(clickDebugDescription(hitRecord))")
                        Thread.sleep(forTimeInterval: 0.15)
                        return true
                    }

                    if shouldScanDescendantsOfHitRecord(
                        originalFrame: clickFrame(for: record, snapshot: snapshot),
                        hitFrame: hitRecord.localFrame
                    ) {
                        for candidate in descendantClickCandidates(
                            for: hitRecord,
                            snapshot: snapshot,
                            sideActionScope: record
                        ) {
                            if try performPreferredClick(on: candidate, button: button, clickCount: clickCount) {
                                debugClickDecision("handled by hit descendant \(clickDebugDescription(candidate))")
                                Thread.sleep(forTimeInterval: 0.15)
                                return true
                            }
                        }
                    }
                }
            }
        }

        guard
            allowActivationFallback,
            !record.isSyntheticText,
            button == .left,
            let element = record.element,
            canUseActivationOnlyClickFallback(role: stringValue(of: element, attribute: kAXRoleAttribute))
        else {
            return false
        }

        ComputerUseTrace.mark("activationFallback attempt")
        if try ComputerUseTrace.measure("activateClickTarget", {
            try activateClickTarget(element: element, availableActions: record.rawActions)
        }) {
            debugClickDecision("handled by activation fallback \(clickDebugDescription(record))")
            Thread.sleep(forTimeInterval: 0.15)
            return true
        }

        return false
    }

    private func performAction(named action: String, on element: AXUIElement, availableActions: [String], repeatCount: Int = 1) throws -> Bool {
        guard availableActions.contains(where: { $0.caseInsensitiveCompare(action) == .orderedSame }) else {
            return false
        }

        let attempts = max(repeatCount, 1)
        for index in 0..<attempts {
            let result = AXUIElementPerformAction(element, action as CFString)
            switch result {
            case .success:
                if index < attempts - 1 {
                    Thread.sleep(forTimeInterval: 0.05)
                }
            case .attributeUnsupported where action.caseInsensitiveCompare("AXOpen") == .orderedSame:
                return true
            case .failure, .actionUnsupported, .attributeUnsupported, .cannotComplete, .noValue, .invalidUIElement, .illegalArgument:
                return false
            default:
                throw ComputerUseError.message("AXUIElementPerformAction(\(action)) failed with \(result.rawValue)")
            }
        }

        return true
    }

    /// Focus attribute fallback for click when Press/Confirm are unavailable.
    /// Does not perform AXRaise — that is only used when the agent explicitly
    /// invokes secondary action Raise via performSecondaryAction.
    private func activateClickTarget(element: AXUIElement, availableActions: [String]) throws -> Bool {
        _ = availableActions
        return try setBoolAttribute(named: kAXFocusedAttribute, on: element)
    }

    private func setBoolAttribute(named attribute: String, on element: AXUIElement) throws -> Bool {
        let result = AXUIElementSetAttributeValue(element, attribute as CFString, kCFBooleanTrue)
        switch result {
        case .success:
            return true
        case .failure, .attributeUnsupported, .actionUnsupported, .cannotComplete, .noValue, .invalidUIElement, .illegalArgument:
            return false
        default:
            throw ComputerUseError.message("AXUIElementSetAttributeValue(\(attribute)) failed with \(result.rawValue)")
        }
    }

    private func isSettable(element: AXUIElement, attribute: String) -> Bool {
        var settable: DarwinBoolean = false
        let result = AXUIElementIsAttributeSettable(element, attribute as CFString, &settable)
        return result == .success && settable.boolValue
    }

    private func isSettableForSetValue(element: AXUIElement, attribute: String) throws -> Bool {
        var settable = DarwinBoolean(false)
        let result = AXUIElementIsAttributeSettable(element, attribute as CFString, &settable)
        return try setValueAttributeIsSettable(
            result: result,
            settable: settable.boolValue,
            attribute: attribute
        )
    }

    private func bestElement(containing point: CGPoint, in snapshot: AppSnapshot) -> ElementRecord? {
        snapshot.elements.values
            .filter { $0.localFrame?.contains(point) ?? false }
            .sorted { lhs, rhs in
                let lhsPriority = clickPriority(for: lhs)
                let rhsPriority = clickPriority(for: rhs)
                if lhsPriority != rhsPriority {
                    return lhsPriority < rhsPriority
                }

                return frameArea(of: lhs) < frameArea(of: rhs)
            }
            .first
    }

    private func hitTestElement(at point: CGPoint, in snapshot: AppSnapshot) throws -> ElementRecord? {
        let appElement = AXUIElementCreateApplication(snapshot.app.pid)
        let globalPoint = try screenshotToGlobalPoint(snapshot: snapshot, x: Double(point.x), y: Double(point.y))
        var hitElement: AXUIElement?
        let result = AXUIElementCopyElementAtPosition(appElement, Float(globalPoint.x), Float(globalPoint.y), &hitElement)
        guard result == .success, let hitElement else {
            return nil
        }

        let rawActions = copyActions(for: hitElement) ?? []
        return ElementRecord(
            index: -1,
            identifier: nil,
            element: hitElement,
            localFrame: localFrame(of: hitElement, windowBounds: snapshot.windowBounds),
            rawActions: rawActions,
            prettyActions: rawActions
        )
    }

    private func clickPriority(for record: ElementRecord) -> Int {
        if record.rawActions.contains(where: {
            $0.caseInsensitiveCompare(kAXPressAction as String) == .orderedSame ||
            $0.caseInsensitiveCompare(kAXConfirmAction as String) == .orderedSame ||
            $0.caseInsensitiveCompare(kAXShowMenuAction as String) == .orderedSame ||
            $0.caseInsensitiveCompare(kAXRaiseAction as String) == .orderedSame
        }) {
            return 0
        }

        if let element = record.element,
           isSettable(element: element, attribute: kAXMainAttribute) ||
           isSettable(element: element, attribute: kAXFocusedAttribute) {
            return 1
        }

        return 2
    }

    private func frameArea(of record: ElementRecord) -> CGFloat {
        guard let frame = record.localFrame else {
            return .greatestFiniteMagnitude
        }

        return frame.width * frame.height
    }

    private func localCenter(for record: ElementRecord) -> CGPoint? {
        guard let frame = record.localFrame else {
            return nil
        }

        return CGPoint(x: frame.midX, y: frame.midY)
    }

    private func clickActionPoints(for record: ElementRecord, snapshot: AppSnapshot) -> [CGPoint] {
        guard let frame = clickFrame(for: record, snapshot: snapshot) else {
            return []
        }

        return localClickActionPoints(frame: frame, isSyntheticText: record.isSyntheticText)
    }

    private func descendantClickCandidates(
        for record: ElementRecord,
        snapshot: AppSnapshot,
        sideActionScope: ElementRecord? = nil
    ) -> [ElementRecord] {
        guard let element = record.element else {
            return []
        }

        let sideActionParent = sideActionScope ?? record
        return descendantClickCandidates(of: element, windowBounds: snapshot.windowBounds)
            .filter { candidate in
                !isLikelySyntheticSideAction(candidate, in: sideActionParent)
            }
            .sorted { lhs, rhs in
                let lhsPriority = clickPriority(for: lhs)
                let rhsPriority = clickPriority(for: rhs)
                if lhsPriority != rhsPriority {
                    return lhsPriority < rhsPriority
                }

                return frameArea(of: lhs) < frameArea(of: rhs)
            }
    }

    private func descendantClickCandidates(of element: AXUIElement, windowBounds: CGRect?, depth: Int = 0) -> [ElementRecord] {
        guard depth < 3 else {
            return []
        }

        var results: [ElementRecord] = []
        for child in copyChildren(of: element) {
            let rawActions = copyActions(for: child) ?? []
            results.append(
                ElementRecord(
                    index: -1,
                    identifier: nil,
                    element: child,
                    localFrame: localFrame(of: child, windowBounds: windowBounds),
                    rawActions: rawActions,
                    prettyActions: rawActions
                )
            )
            results.append(contentsOf: descendantClickCandidates(of: child, windowBounds: windowBounds, depth: depth + 1))
        }

        return results
    }

    private func isLikelySyntheticSideAction(_ candidate: ElementRecord, in parent: ElementRecord) -> Bool {
        isLikelySyntheticSideActionCandidate(
            parentFrame: parent.localFrame,
            candidateFrame: candidate.localFrame,
            hasPrimaryAction: hasPrimaryClickAction(candidate),
            labels: accessibilityLabels(for: candidate.element)
        )
    }

    private func hasPrimaryClickAction(_ record: ElementRecord) -> Bool {
        record.rawActions.contains { action in
            action.caseInsensitiveCompare(kAXPressAction as String) == .orderedSame ||
                action.caseInsensitiveCompare(kAXConfirmAction as String) == .orderedSame ||
                action.caseInsensitiveCompare("AXOpen") == .orderedSame ||
                action.caseInsensitiveCompare(kAXShowMenuAction as String) == .orderedSame
        }
    }

    private func shouldPreferContainingWebRowAXClick(_ record: ElementRecord, in snapshot: AppSnapshot) -> Bool {
        guard
            let element = record.element
        else {
            return false
        }

        return shouldPreferContainingWebRowAXClickCandidate(
            role: stringValue(of: element, attribute: kAXRoleAttribute),
            isSyntheticText: record.isSyntheticText,
            hasWebAreaAncestor: hasAncestorRole("AXWebArea", of: element),
            appName: snapshot.app.name,
            bundleIdentifier: snapshot.app.bundleIdentifier
        )
    }

    private func performContainingWebRowClick(
        for record: ElementRecord,
        snapshot: AppSnapshot,
        button: MouseButtonKind,
        clickCount: Int
    ) throws -> Bool {
        guard
            button == .left,
            clickCount <= 1,
            let element = record.element,
            let targetFrame = record.localFrame
        else {
            return false
        }

        var current = element

        for _ in 0..<6 {
            guard let parent = copyParent(of: current) else {
                return false
            }

            let rawActions = copyActions(for: parent) ?? []
            let candidate = ElementRecord(
                index: -1,
                identifier: nil,
                element: parent,
                localFrame: localFrame(of: parent, windowBounds: snapshot.windowBounds),
                rawActions: rawActions,
                prettyActions: rawActions
            )

            if isLikelyContainingWebRowAction(targetFrame: targetFrame, candidate: candidate),
               !isLikelySyntheticSideAction(candidate, in: record),
               try performAction(named: kAXPressAction as String, on: parent, availableActions: rawActions)
            {
                debugClickDecision("handled by containing web row \(clickDebugDescription(candidate))")
                return true
            }

            current = parent
        }

        return false
    }

    private func isLikelyContainingWebRowAction(
        targetFrame: CGRect,
        candidate: ElementRecord
    ) -> Bool {
        isLikelyContainingRowActionFrame(
            targetFrame: targetFrame,
            candidateFrame: candidate.localFrame,
            hasPrimaryAction: hasPrimaryClickAction(candidate)
        )
    }

    private func hasAncestorRole(_ role: String, of element: AXUIElement) -> Bool {
        var current = element

        for _ in 0..<12 {
            guard let parent = copyParent(of: current) else {
                return false
            }

            if stringValue(of: parent, attribute: kAXRoleAttribute) == role {
                return true
            }

            current = parent
        }

        return false
    }

    private func accessibilityLabels(for element: AXUIElement?) -> [String] {
        guard let element else {
            return []
        }

        return [
            kAXTitleAttribute as String,
            kAXDescriptionAttribute as String,
            kAXHelpAttribute as String,
            kAXValueAttribute as String,
            "AXIdentifier"
        ].compactMap { attribute in
            stringValue(of: element, attribute: attribute)
        }
    }

    private func typeTextBySettingFocusedValueIfAvailable(_ text: String, into element: AXUIElement?) throws -> Bool {
        guard let element else {
            return false
        }

        guard try isSettableForSetValue(element: element, attribute: kAXValueAttribute) else {
            return false
        }

        let baseValue = editableBaseValue(for: element)
        let result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, (baseValue + text) as CFString)
        switch result {
        case .success:
            return true
        case .failure, .attributeUnsupported, .actionUnsupported, .cannotComplete, .noValue, .invalidUIElement, .illegalArgument:
            return false
        default:
            throw ComputerUseError.message("AXUIElementSetAttributeValue failed with \(result.rawValue)")
        }
    }

    private func canTypeTextUsingKeyboardFallback(element: AXUIElement?) throws -> Bool {
        guard let element else {
            return false
        }

        let role = stringValue(of: element, attribute: kAXRoleAttribute)
        let roleDescription = role.flatMap {
            stringValue(of: element, attribute: kAXRoleDescriptionAttribute) ?? humanizedRoleDescription(for: $0)
        }
        return canUseKeyboardTextFallback(
            role: role,
            roleDescription: roleDescription,
            isValueSettable: try isSettableForSetValue(element: element, attribute: kAXValueAttribute)
        )
    }

    private func humanizedRoleDescription(for role: String) -> String {
        if role == kAXTextFieldRole as String {
            return "text field"
        }

        switch role {
        case "AXTextArea", "AXTextView":
            return "text entry area"
        default:
            return ""
        }
    }

    private func editableBaseValue(for element: AXUIElement) -> String {
        let childTextValues = editableDescendantTextValues(in: element)
            .filter { !looksLikeEditablePlaceholder($0) }
        if !childTextValues.isEmpty {
            return childTextValues.joined()
        }

        guard let currentValue = stringValue(of: element, attribute: kAXValueAttribute) else {
            return ""
        }

        let normalizedValue = normalizeEditablePlaceholderText(currentValue)
        if normalizedValue.isEmpty || looksLikeEditablePlaceholder(normalizedValue) {
            return ""
        }

        for attribute in ["AXPlaceholderValue", "AXPlaceholder"] {
            guard let placeholder = stringValue(of: element, attribute: attribute) else {
                continue
            }

            if normalizedValue == normalizeEditablePlaceholderText(placeholder) {
                return ""
            }
        }

        return currentValue
    }

    private func editableDescendantTextValues(in element: AXUIElement, depth: Int = 0) -> [String] {
        guard depth < 4 else {
            return []
        }

        var values: [String] = []
        for child in copyChildren(of: element) {
            if stringValue(of: child, attribute: kAXRoleAttribute) == kAXStaticTextRole as String,
               let value = stringValue(of: child, attribute: kAXValueAttribute)
                    ?? stringValue(of: child, attribute: kAXTitleAttribute)
            {
                let normalized = normalizeEditablePlaceholderText(value)
                if !normalized.isEmpty {
                    values.append(normalized)
                }
            }

            values.append(contentsOf: editableDescendantTextValues(in: child, depth: depth + 1))
        }

        return values
    }

    private func looksLikeEditablePlaceholder(_ value: String) -> Bool {
        let normalized = normalizeEditablePlaceholderText(value)
        return normalized == "沟通时请保持“公开可接受”"
    }

    private func normalizeEditablePlaceholderText(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\u{200B}", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func clickFrame(for record: ElementRecord, snapshot: AppSnapshot) -> CGRect? {
        guard let frame = record.localFrame else {
            return nil
        }

        guard
            !record.isSyntheticText,
            let element = record.element,
            stringValue(of: element, attribute: kAXRoleAttribute) == kAXStaticTextRole as String,
            let rowFrame = containingRowFrame(for: element, textFrame: frame, windowBounds: snapshot.windowBounds)
        else {
            return frame
        }

        return rowFrame
    }

    private func containingRowFrame(for element: AXUIElement, textFrame: CGRect, windowBounds: CGRect?) -> CGRect? {
        let textCenter = CGPoint(x: textFrame.midX, y: textFrame.midY)
        var current = element

        for _ in 0..<4 {
            guard let parent = copyParent(of: current) else {
                return nil
            }

            if let frame = localFrame(of: parent, windowBounds: windowBounds),
               frame.insetBy(dx: -2, dy: -2).contains(textCenter),
               frame.width >= textFrame.width + 40,
               frame.height >= textFrame.height,
               frame.height <= max(textFrame.height * 4, 96)
            {
                return frame
            }

            current = parent
        }

        return nil
    }

    private func copyActions(for element: AXUIElement) -> [String]? {
        var actions: CFArray?
        let result = AXUIElementCopyActionNames(element, &actions)
        guard result == .success else {
            return nil
        }

        return actions as? [String]
    }

    private func copyChildren(of element: AXUIElement) -> [AXUIElement] {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value)
        guard result == .success, let value else {
            return []
        }

        return value as? [AXUIElement] ?? []
    }

    private func copyParent(of element: AXUIElement) -> AXUIElement? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &value)
        guard result == .success, let value else {
            return nil
        }

        return (value as! AXUIElement)
    }

    private func stringValue(of element: AXUIElement, attribute: String) -> String? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        guard result == .success, let value else {
            return nil
        }

        return value as? String
    }

    private func localFrame(of element: AXUIElement, windowBounds: CGRect?) -> CGRect? {
        var positionValue: CFTypeRef?
        var sizeValue: CFTypeRef?
        let positionResult = AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue)
        let sizeResult = AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue)

        guard
            positionResult == .success,
            sizeResult == .success,
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
        guard let windowBounds else {
            return frame
        }

        return windowRelativeFrame(elementFrame: frame, windowBounds: windowBounds)
    }

    private func globalPoint(for record: ElementRecord, snapshot: AppSnapshot) throws -> CGPoint? {
        guard let frame = record.localFrame else {
            return nil
        }

        return try windowPointToGlobalPoint(
            snapshot: snapshot,
            point: CGPoint(x: frame.midX, y: frame.midY)
        )
    }

    private func globalClickPoint(for record: ElementRecord, snapshot: AppSnapshot) throws -> CGPoint? {
        guard let point = clickActionPoints(for: record, snapshot: snapshot).first ?? localCenter(for: record) else {
            return nil
        }

        return try windowPointToGlobalPoint(snapshot: snapshot, point: point)
    }

    private func screenshotToGlobalPoint(snapshot: AppSnapshot, x: Double, y: Double) throws -> CGPoint {
        try windowPointToGlobalPoint(
            snapshot: snapshot,
            point: screenshotPixelToWindowPointInSnapshot(
                snapshot: snapshot,
                point: CGPoint(x: x, y: y)
            )
        )
    }

    private func screenshotPixelToWindowPointInSnapshot(snapshot: AppSnapshot, point: CGPoint) -> CGPoint {
        screenshotPixelToWindowPoint(
            point,
            screenshotPixelSize: screenshotPixelSize(snapshot: snapshot),
            windowBounds: snapshot.windowBounds
        )
    }

    private func screenshotPixelSize(snapshot: AppSnapshot) -> CGSize? {
        guard
            let screenshotImageData = snapshot.screenshotImageData,
            let imageSource = CGImageSourceCreateWithData(screenshotImageData as CFData, nil),
            let properties = CGImageSourceCopyPropertiesAtIndex(imageSource, 0, nil) as? [CFString: Any],
            let pixelWidth = properties[kCGImagePropertyPixelWidth] as? CGFloat,
            let pixelHeight = properties[kCGImagePropertyPixelHeight] as? CGFloat,
            pixelWidth > 0,
            pixelHeight > 0
        else {
            return nil
        }

        return CGSize(width: pixelWidth, height: pixelHeight)
    }

    private func windowPointToGlobalPoint(snapshot: AppSnapshot, point: CGPoint) throws -> CGPoint {
        guard let windowBounds = snapshot.windowBounds else {
            let appReference = snapshot.app.bundleIdentifier ?? snapshot.app.name
            throw ComputerUseError.stateUnavailable("No window bounds are available for \(appReference). Run get_app_state after bringing the app on screen.")
        }

        return CGPoint(x: windowBounds.minX + point.x, y: windowBounds.minY + point.y)
    }

    private func fixtureIdentifier(at point: CGPoint, snapshot: AppSnapshot) throws -> String {
        let candidates = snapshot.elements.values
            .filter { $0.identifier != nil && ($0.localFrame?.contains(point) ?? false) }
            .sorted { lhs, rhs in
                let lhsArea = (lhs.localFrame?.width ?? 0) * (lhs.localFrame?.height ?? 0)
                let rhsArea = (rhs.localFrame?.width ?? 0) * (rhs.localFrame?.height ?? 0)
                return lhsArea < rhsArea
            }

        guard let identifier = candidates.first?.identifier else {
            throw ComputerUseError.invalidArguments("No fixture element contains coordinate (\(Int(point.x)), \(Int(point.y)))")
        }

        return identifier
    }

    private func visualCursorTarget(for record: ElementRecord, snapshot: AppSnapshot) -> VisualCursorTarget? {
        makeVisualCursorTarget(
            localFrame: record.localFrame,
            windowBounds: snapshot.windowBounds,
            targetWindowID: snapshot.targetWindowID,
            targetWindowLayer: snapshot.targetWindowLayer
        )
    }

    private func fixtureVisualCursorTarget(identifier: String, snapshot: AppSnapshot) -> VisualCursorTarget? {
        let record = snapshot.elements.values.first { $0.identifier == identifier }
        return record.flatMap { visualCursorTarget(for: $0, snapshot: snapshot) }
    }

    private func moveVisualCursor(to target: VisualCursorTarget?) {
        guard let target else {
            return
        }

        VisualCursorSupport.performOnMain {
            SoftwareCursorOverlay.moveCursor(to: target.point, in: target.window)
        }
    }

    private func settleVisualCursor(at target: VisualCursorTarget?) {
        guard let target else {
            return
        }

        VisualCursorSupport.performOnMain {
            SoftwareCursorOverlay.settle(at: target.point, in: target.window)
        }
    }

    private func pulseVisualCursor(at target: VisualCursorTarget?, clickCount: Int, mouseButton: MouseButtonKind) {
        guard let target else {
            return
        }

        VisualCursorSupport.performOnMain {
            SoftwareCursorOverlay.pulseClick(
                at: target.point,
                clickCount: clickCount,
                mouseButton: mouseButton,
                in: target.window
            )
        }
    }

    private func debugInputFallback(tool: String, targetDescription: String, snapshot: AppSnapshot) {
        guard inputFallbackDebugEnabled(environment: ProcessInfo.processInfo.environment) else {
            return
        }

        let appReference = snapshot.app.bundleIdentifier ?? snapshot.app.name
        fputs(
            "[open-computer-use] global pointer fallback tool=\(tool) app=\(appReference) target=\(targetDescription)\n",
            stderr
        )
    }

    private func debugClickDecision(_ message: String) {
        guard inputFallbackDebugEnabled(environment: ProcessInfo.processInfo.environment) else {
            return
        }

        fputs("[open-computer-use] click decision \(message)\n", stderr)
    }

    private func clickDebugDescription(_ record: ElementRecord) -> String {
        let role = record.element.flatMap { stringValue(of: $0, attribute: kAXRoleAttribute) } ?? "nil"
        let actions = record.rawActions.joined(separator: ",")
        let frame = record.localFrame.map { "x=\(Int($0.minX)) y=\(Int($0.minY)) w=\(Int($0.width)) h=\(Int($0.height))" } ?? "nil"
        return "index=\(record.index) role=\(role) synthetic=\(record.isSyntheticText) actions=[\(actions)] frame=\(frame)"
    }

    private func integralScrollPageCount(_ pages: Double) -> Int? {
        let rounded = pages.rounded(.toNearestOrAwayFromZero)
        guard abs(pages - rounded) < 0.000001 else {
            return nil
        }
        return max(Int(rounded), 1)
    }

    private func performScrollEvent(
        at point: CGPoint,
        direction: String,
        pages: Double,
        targetDescription: String,
        snapshot: AppSnapshot
    ) throws {
        let eventPoint = inputEventPoint(fromScreenStatePoint: point)
        enforceBackgroundFocus(for: snapshot)

        // Always prefer targeted postToPid. Global HID fallback never activates
        // the target; it only moves the real cursor when explicitly enabled.
        do {
            let target = mouseEventTarget(
                for: snapshot,
                insideWebView: snapshot.containsWebArea
            )
            try InputSimulation.scrollTargeted(
                at: eventPoint,
                direction: direction,
                pages: pages,
                pid: snapshot.app.pid,
                windowID: snapshot.targetWindowID,
                windowBounds: target?.windowBounds ?? snapshot.windowBounds
            )
            noteSynthesizedAction(for: snapshot)
            return
        } catch {
            guard globalPointerFallbacksEnabled(environment: ProcessInfo.processInfo.environment) else {
                throw error
            }
            debugInputFallback(
                tool: "scroll",
                targetDescription: targetDescription,
                snapshot: snapshot
            )
            try InputSimulation.scrollGlobally(at: eventPoint, direction: direction, pages: pages)
            noteSynthesizedAction(for: snapshot)
        }
    }

    private func performDragEvent(
        from start: CGPoint,
        to end: CGPoint,
        targetDescription: String,
        snapshot: AppSnapshot
    ) throws {
        let eventStart = inputEventPoint(fromScreenStatePoint: start)
        let eventEnd = inputEventPoint(fromScreenStatePoint: end)
        enforceBackgroundFocus(for: snapshot)

        do {
            try InputSimulation.dragTargeted(
                from: eventStart,
                to: eventEnd,
                pid: snapshot.app.pid,
                windowID: snapshot.targetWindowID,
                windowBounds: snapshot.windowBounds
            )
            noteSynthesizedAction(for: snapshot)
            return
        } catch {
            guard globalPointerFallbacksEnabled(environment: ProcessInfo.processInfo.environment) else {
                throw error
            }
            debugInputFallback(
                tool: "drag",
                targetDescription: targetDescription,
                snapshot: snapshot
            )
            try InputSimulation.dragGlobally(from: eventStart, to: eventEnd)
            noteSynthesizedAction(for: snapshot)
        }
    }

    private func performNonAXClickFallback(
        at point: CGPoint,
        button: MouseButtonKind,
        clickCount: Int,
        targetDescription: String,
        snapshot: AppSnapshot
    ) throws {
        // Legacy entry point — routes through Codex sendClick.
        _ = targetDescription
        _ = syntheticallyActivateIfNeededForSendingClick(
            snapshot: snapshot,
            isInsideWebView: snapshot.containsWebArea,
            clickingByCoordinate: true
        )
        do {
            try sendClickCodex(
                at: point,
                button: button,
                clickCount: clickCount,
                snapshot: snapshot,
                insideWebView: snapshot.containsWebArea
            )
        } catch {
            guard globalPointerFallbacksEnabled(environment: ProcessInfo.processInfo.environment) else {
                throw ComputerUseError.message(
                    "click could not be handled through accessibility, and global pointer fallback is disabled. Set OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS=1 to allow physical-pointer fallback for this process."
                )
            }
            debugInputFallback(
                tool: "click",
                targetDescription: targetDescription,
                snapshot: snapshot
            )
            let eventPoint = inputEventPoint(fromScreenStatePoint: point)
            try InputSimulation.clickGlobally(at: eventPoint, button: button, clickCount: clickCount)
            noteSynthesizedAction(for: snapshot)
        }
    }

    private func snapshotResult(for snapshot: AppSnapshot, style: SnapshotTextStyle) -> ToolCallResult {
        var content = [ToolResultContentItem.text(snapshot.renderedText(style: style))]
        if let screenshotImageData = snapshot.screenshotImageData {
            content.append(.jpegImage(screenshotImageData))
        }
        return ToolCallResult(content: content)
    }
}

private struct UISettlingObservation: Equatable {
    let accessibilityText: String
    let appearsToBeLoading: Bool
    let screenshotImageData: Data?
}
