import AppKit
import Foundation
import OpenComputerUseKit

private struct ActiveComputerUsePresentation: Equatable {
    let scope: ComputerUseTurnScope
    let appReference: String
    let bundleIdentifier: String
    let displayName: String
    let appPath: String?
}

func computerUseStatusMenuTitles(activeDisplayName: String?) -> [String] {
    guard let activeDisplayName else {
        return []
    }
    return [activeDisplayName, "Stop Computer Use for \(activeDisplayName)"]
}

func computerUsePresentationPayload(
    type: String,
    scope: ComputerUseTurnScope,
    appReference: String,
    bundleIdentifier: String,
    displayName: String,
    contextID: UInt32?,
    size: CGSize?,
    reason: String?
) -> [String: Any] {
    var payload: [String: Any] = [
        "type": type,
        "sessionID": scope.sessionID,
        "turnID": scope.turnID,
        "app": appReference,
        "bundleIdentifier": bundleIdentifier,
        "displayName": displayName,
    ]
    if let hostSessionID = scope.hostSessionID {
        payload["hostSessionID"] = hostSessionID
    }
    if let contextID {
        payload["contextID"] = contextID
    }
    if let size {
        payload["width"] = Int(size.width)
        payload["height"] = Int(size.height)
    }
    if let reason {
        payload["reason"] = reason
    }
    return payload
}

/// Owns the macOS menu-bar status item and publishes presentation events to the
/// Electron host over stdout.
///
/// Frames are committed to a remote CAContext. stdout carries only lifecycle,
/// context id, and size metadata; it never carries screenshots or file paths.
///
/// stdout is reserved for newline-delimited JSON events; diagnostics use stderr.
@MainActor
final class ComputerUsePresentationController: NSObject {
    static let shared = ComputerUsePresentationController()

    private let emitsHostEvents =
        ProcessInfo.processInfo.environment["OPERON_CU_PRESENTATION_EVENTS"] == "1"
    private var started = false
    private var statusItem: NSStatusItem?
    private var activePresentation: ActiveComputerUsePresentation?
    /// Fallback timer only when SCStream cannot start (permissions / no window).
    private var liveCaptureTimer: Timer?
    private let liveCaptureInterval: TimeInterval = 0.45
    private var liveCaptureInFlight = false
    private var usingStreamCapture = false
    private var remoteContext: RemoteHostedPIPContext?
    private var publishedContextSize = CGSize.zero
    /// Screen Recording is missing: PiP has nothing to show and the host is told
    /// why, once per activation, instead of silently rendering nothing.
    private var screenRecordingBlockReported = false
    private var permissionRetryTimer: Timer?
    private let permissionRetryInterval: TimeInterval = 2

    private override init() {
        super.init()
    }

    func start() {
        guard !started else { return }
        started = true
        setOpenComputerUseVisualCursorPresentationHandler { [weak self] presentation in
            self?.remoteContext?.updateCursor(presentation)
        }
    }

    func activate(
        scope: ComputerUseTurnScope,
        appReference: String,
        bundleIdentifier: String,
        displayName: String,
        appPath: String?
    ) {
        guard started else { return }
        let next = ActiveComputerUsePresentation(
            scope: scope,
            appReference: appReference,
            bundleIdentifier: bundleIdentifier,
            displayName: displayName,
            appPath: appPath
        )
        let appChanged =
            activePresentation?.bundleIdentifier != next.bundleIdentifier
            || activePresentation?.scope.sessionID != next.scope.sessionID
            || activePresentation?.scope.hostSessionID != next.scope.hostSessionID
        let changed = activePresentation != next
        activePresentation = next
        ensureStatusItem()
        renderStatusItem()
        if changed {
            emit(
                type: "active",
                presentation: next,
                contextID: nil,
                size: nil,
                reason: nil
            )
        }
        // Start / keep the live window stream for this controlled app.
        if appChanged || liveCaptureTimer == nil {
            startLiveCapture()
        }
        // Immediate fallback frame so the PiP is not blank until SCStream starts.
        captureAndPublishLiveFrame()
    }

    func end(scope: ComputerUseTurnScope, reason: String) {
        guard started, let activePresentation else {
            return
        }
        // Match by session, not exact turn — endHostSession may carry the last
        // turn_id while activate was called with a newer one.
        let matches =
            activePresentation.scope == scope
            || (
                activePresentation.scope.hostSessionID != nil
                    && activePresentation.scope.hostSessionID == scope.hostSessionID
            )
            || (
                activePresentation.scope.sessionID == scope.sessionID
                    && !scope.sessionID.isEmpty
            )
        guard matches else {
            return
        }
        emit(
            type: "ended",
            presentation: activePresentation,
            contextID: nil,
            size: nil,
            reason: reason
        )
        stopLiveCapture()
        // Per session: the next one reports its own block if it hits one.
        screenRecordingBlockReported = false
        self.activePresentation = nil
        removeStatusItem()
    }

    @objc
    private func stopActivePresentation() {
        UserInterruptionMonitor.shared.stopActiveTurn()
    }

    private func startLiveCapture() {
        stopLiveCapture()
        guard emitsHostEvents, let activePresentation else { return }

        // Every frame source (SCStream and the one-shot fallback) needs Screen
        // Recording. Report the block and keep re-checking: the user can grant
        // it in System Settings mid-session, and PiP should light up by itself.
        guard ScreenRecordingAccess.isGranted else {
            ScreenRecordingAccess.promptOnce()
            reportScreenRecordingBlock(for: activePresentation)
            startPermissionRetry()
            return
        }
        screenRecordingBlockReported = false

        let bundleIdentifier = activePresentation.bundleIdentifier
        guard let remoteContext = RemoteHostedPIPContext() else {
            fputs("[operon-computer-use] remote CAContext unavailable\n", stderr)
            return
        }
        self.remoteContext = remoteContext
        publishedContextSize = .zero
        ComputerUseTrace.mark("PiP remote context created id=\(remoteContext.contextID)")

        // The SCStream commits shared surfaces directly into the remote context.
        usingStreamCapture = true
        let publishFrame: @MainActor @Sendable (LiveWindowSurfaceFrame) -> Void = {
            [weak self, weak remoteContext] frame in
            MainActor.assumeIsolated {
                guard let self,
                      let remoteContext,
                      self.remoteContext === remoteContext
                else {
                    return
                }
                let sizeChanged = remoteContext.present(frame)
                self.publishRemoteContextIfNeeded(sizeChanged: sizeChanged)
            }
        }
        LiveWindowStream.shared.start(bundleIdentifier: bundleIdentifier, onFrame: publishFrame)

        // Fallback timer if the stream fails to produce frames within 1.2s.
        let timer = Timer(timeInterval: liveCaptureInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                if !LiveWindowStream.shared.isStreaming {
                    // activate() intentionally runs before app discovery/launch.
                    // Retry until the target has a streamable window.
                    LiveWindowStream.shared.start(
                        bundleIdentifier: bundleIdentifier,
                        onFrame: publishFrame
                    )
                }
                if LiveWindowStream.shared.isStreaming && LiveWindowStream.shared.hasProducedFrame {
                    // Stream is healthy — skip one-shot captures.
                    return
                }
                self.usingStreamCapture = false
                self.captureAndPublishLiveFrame()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        liveCaptureTimer = timer

        // Immediate still so PiP is not blank before the first sample buffer.
        captureAndPublishLiveFrame()
    }

    private func reportScreenRecordingBlock(for presentation: ActiveComputerUsePresentation) {
        guard !screenRecordingBlockReported else { return }
        screenRecordingBlockReported = true
        ComputerUseTrace.mark("PiP blocked: screen recording not granted")
        emit(
            type: "blocked",
            presentation: presentation,
            contextID: nil,
            size: nil,
            reason: "screen-recording"
        )
    }

    private func startPermissionRetry() {
        permissionRetryTimer?.invalidate()
        let timer = Timer(timeInterval: permissionRetryInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.activePresentation != nil else { return }
                guard ScreenRecordingAccess.isGranted else { return }
                // Granted while the turn was running — start the real pipeline.
                self.startLiveCapture()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        permissionRetryTimer = timer
    }

    private func stopLiveCapture() {
        LiveWindowStream.shared.stop()
        usingStreamCapture = false
        permissionRetryTimer?.invalidate()
        permissionRetryTimer = nil
        liveCaptureTimer?.invalidate()
        liveCaptureTimer = nil
        liveCaptureInFlight = false
        remoteContext?.invalidate()
        remoteContext = nil
        publishedContextSize = .zero
    }

    private func captureAndPublishLiveFrame() {
        guard emitsHostEvents,
              let activePresentation,
              let remoteContext,
              !liveCaptureInFlight
        else {
            return
        }
        liveCaptureInFlight = true
        let bundleIdentifier = activePresentation.bundleIdentifier
        DispatchQueue.global(qos: .userInitiated).async { [weak self, weak remoteContext] in
            let image = PresentationWindowCapture.cgImage(bundleIdentifier: bundleIdentifier)
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self,
                          let remoteContext,
                          self.remoteContext === remoteContext
                    else {
                        return
                    }
                    self.liveCaptureInFlight = false
                    guard let image else {
                        ComputerUseTrace.mark("PiP fallback capture returned no image")
                        return
                    }
                    let sizeChanged = remoteContext.present(cgImage: image)
                    ComputerUseTrace.mark(
                        "PiP fallback committed \(image.width)x\(image.height) changed=\(sizeChanged)"
                    )
                    self.publishRemoteContextIfNeeded(sizeChanged: sizeChanged)
                }
            }
        }
    }

    private func publishRemoteContextIfNeeded(sizeChanged: Bool) {
        guard let activePresentation,
              let remoteContext,
              remoteContext.size.width > 0,
              remoteContext.size.height > 0,
              sizeChanged || publishedContextSize == .zero
        else {
            return
        }
        publishedContextSize = remoteContext.size
        emit(
            type: "presentation",
            presentation: activePresentation,
            contextID: remoteContext.contextID,
            size: remoteContext.size,
            reason: nil
        )
    }

    private func renderStatusItem() {
        guard let activePresentation,
              let statusItem,
              let button = statusItem.button
        else {
            return
        }

        let menu = NSMenu()
        let labels = computerUseStatusMenuTitles(activeDisplayName: activePresentation.displayName)
        statusItem.length = 44
        button.image = activeStatusImage(for: activePresentation)
        button.toolTip = "Computer Use is controlling \(activePresentation.displayName)"

        let appItem = NSMenuItem(title: labels[0], action: nil, keyEquivalent: "")
        appItem.isEnabled = false
        menu.addItem(appItem)
        menu.addItem(.separator())

        let stopItem = NSMenuItem(
            title: labels[1],
            action: #selector(stopActivePresentation),
            keyEquivalent: ""
        )
        stopItem.target = self
        menu.addItem(stopItem)

        button.imagePosition = .imageOnly
        statusItem.menu = menu
    }

    private func ensureStatusItem() {
        guard statusItem == nil else { return }
        statusItem = NSStatusBar.system.statusItem(withLength: 44)
    }

    private func removeStatusItem() {
        guard let statusItem else { return }
        statusItem.menu = nil
        NSStatusBar.system.removeStatusItem(statusItem)
        self.statusItem = nil
    }

    private func activeStatusImage(
        for presentation: ActiveComputerUsePresentation
    ) -> NSImage? {
        let appIcon: NSImage?
        if let appPath = presentation.appPath, !appPath.isEmpty {
            appIcon = NSWorkspace.shared.icon(forFile: appPath)
        } else {
            appIcon = NSRunningApplication
                .runningApplications(withBundleIdentifier: presentation.bundleIdentifier)
                .first?
                .icon
        }

        guard let cursor = NSImage(
                systemSymbolName: "cursorarrow",
                accessibilityDescription: "Computer Use"
              )
        else {
            return appIcon
        }

        let image = NSImage(size: CGSize(width: 36, height: 18), flipped: false) { _ in
            appIcon?.draw(
                in: CGRect(x: 0, y: 0, width: 18, height: 18),
                from: .zero,
                operation: .sourceOver,
                fraction: 1
            )
            cursor.draw(
                in: CGRect(x: 22, y: 1, width: 14, height: 14),
                from: .zero,
                operation: .sourceOver,
                fraction: 1
            )
            return true
        }
        image.isTemplate = false
        return image
    }

    private func emit(
        type: String,
        presentation: ActiveComputerUsePresentation,
        contextID: UInt32?,
        size: CGSize?,
        reason: String?
    ) {
        guard emitsHostEvents else { return }
        let payload = computerUsePresentationPayload(
            type: type,
            scope: presentation.scope,
            appReference: presentation.appReference,
            bundleIdentifier: presentation.bundleIdentifier,
            displayName: presentation.displayName,
            contextID: contextID,
            size: size,
            reason: reason
        )
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else {
            return
        }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}
