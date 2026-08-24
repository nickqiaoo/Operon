import AppKit
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import IOSurface
import ScreenCaptureKit

/// A retained ScreenCaptureKit surface. The IOSurface remains alive while the
/// remote CAContext commits it, so no encoded image or temporary file is needed.
public final class LiveWindowSurfaceFrame: @unchecked Sendable {
    public let surface: IOSurface
    public let width: Int
    public let height: Int

    public init(surface: IOSurface, width: Int, height: Int) {
        self.surface = surface
        self.width = width
        self.height = height
    }
}

/// Continuous ScreenCaptureKit stream of one window. Frames stay as shared
/// IOSurfaces and are committed into a remote Core Animation context.
@MainActor
public final class LiveWindowStream: NSObject, SCStreamOutput, SCStreamDelegate {
    public static let shared = LiveWindowStream()

    private var stream: SCStream?
    private var onFrame: (@MainActor @Sendable (LiveWindowSurfaceFrame) -> Void)?
    private var activeWindowID: CGWindowID = 0
    private var starting = false
    public private(set) var hasProducedFrame = false

    private override init() {
        super.init()
    }

    public var isStreaming: Bool {
        stream != nil
    }

    /// Start (or replace) a stream for `bundleIdentifier`'s best on-screen window.
    public func start(
        bundleIdentifier: String,
        onFrame: @escaping @MainActor @Sendable (LiveWindowSurfaceFrame) -> Void
    ) {
        self.onFrame = onFrame
        hasProducedFrame = false
        guard !starting else { return }
        // Same gate as the snapshot path: without the grant `startCapture()`
        // only fails after a round trip, and the retry timer would repeat it
        // forever. The presentation controller reports the block instead.
        guard ScreenRecordingAccess.isGranted else {
            ComputerUseTrace.mark("PiP stream skipped: screen recording not granted")
            return
        }
        starting = true

        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)
        guard let pid = apps.first?.processIdentifier else {
            ComputerUseTrace.mark("PiP stream has no running app for \(bundleIdentifier)")
            starting = false
            return
        }

        Task { @MainActor in
            defer { self.starting = false }
            do {
                try await self.startStream(pid: pid)
            } catch {
                ComputerUseTrace.mark("PiP stream failed: \(error.localizedDescription)")
                if ScreenRecordingAccess.isUserDeclined(error) {
                    ScreenRecordingAccess.noteCaptureDenied()
                }
                // Fall back is caller's responsibility (timer capture).
                self.stream = nil
            }
        }
    }

    public func stop() {
        starting = false
        onFrame = nil
        activeWindowID = 0
        hasProducedFrame = false
        if let stream {
            Task {
                try? await stream.stopCapture()
            }
        }
        stream = nil
    }

    private func startStream(pid: pid_t) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: false
        )
        let windows = content.windows.filter { $0.owningApplication?.processID == pid }
        guard let window = preferredWindow(from: windows) else {
            throw ComputerUseError.stateUnavailable("no streamable window")
        }
        ComputerUseTrace.mark(
            "PiP stream selected window \(window.windowID) \(Int(window.frame.width))x\(Int(window.frame.height))"
        )

        if stream != nil, activeWindowID == window.windowID {
            return
        }

        if let stream {
            try? await stream.stopCapture()
            self.stream = nil
        }

        activeWindowID = window.windowID
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        let scale = NSScreen.main?.backingScaleFactor ?? 2
        let size = window.frame.size
        // Cap resolution for PiP bandwidth.
        let maxEdge: CGFloat = 720
        let scaleDown = min(1, maxEdge / max(size.width, size.height, 1))
        configuration.width = max(1, Int(ceil(size.width * scale * scaleDown)))
        configuration.height = max(1, Int(ceil(size.height * scale * scaleDown)))
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 8) // ~8 fps
        configuration.queueDepth = 3
        configuration.showsCursor = false
        configuration.scalesToFit = true

        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: .global(qos: .userInitiated))
        try await stream.startCapture()
        self.stream = stream
        ComputerUseTrace.mark("PiP stream started")
    }

    private func preferredWindow(from windows: [SCWindow]) -> SCWindow? {
        windows
            .filter { $0.frame.width * $0.frame.height >= 20_000 }
            .sorted { $0.frame.width * $0.frame.height > $1.frame.width * $1.frame.height }
            .first
            ?? windows.first
    }

    // MARK: SCStreamOutput

    public nonisolated func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .screen,
              CMSampleBufferIsValid(sampleBuffer),
              let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer)
        else {
            return
        }

        guard let surface = CVPixelBufferGetIOSurface(imageBuffer)?.takeUnretainedValue() else {
            return
        }
        let frame = LiveWindowSurfaceFrame(
            surface: surface,
            width: CVPixelBufferGetWidth(imageBuffer),
            height: CVPixelBufferGetHeight(imageBuffer)
        )

        Task { @MainActor in
            if !self.hasProducedFrame {
                ComputerUseTrace.mark("PiP stream produced first IOSurface frame \(frame.width)x\(frame.height)")
                ScreenRecordingAccess.noteCaptureAllowed()
            }
            self.hasProducedFrame = true
            self.onFrame?(frame)
        }
    }

    public nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task { @MainActor in
            self.stream = nil
            self.activeWindowID = 0
            self.hasProducedFrame = false
        }
    }
}
