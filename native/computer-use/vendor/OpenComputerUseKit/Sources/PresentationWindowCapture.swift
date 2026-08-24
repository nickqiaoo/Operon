import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

/// Window capture fallback shared by model screenshots and the native PiP producer.
///
/// Live PiP frames normally stay on the ScreenCaptureKit -> IOSurface -> CAContext
/// path. This helper supplies a single CGImage only when that stream cannot start;
/// the image is uploaded to the same remote context without a temporary file.
public enum PresentationWindowCapture {
    /// CGImage for the best layer-0 window of `bundleIdentifier`, or nil.
    /// Used only as a fallback when the continuous SCStream cannot start.
    public static func cgImage(bundleIdentifier: String) -> CGImage? {
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)
        guard let pid = apps.first?.processIdentifier else {
            return nil
        }
        return cgImage(pid: pid)
    }

    public static func cgImage(pid: pid_t) -> CGImage? {
        guard let candidate = preferredWindow(pid: pid) else {
            return nil
        }
        return ScreenCaptureKitWindowCapture.capture(
            windowID: candidate.windowID,
            bounds: candidate.bounds,
            timeout: 0.45
        )
    }

    /// PNG bytes for the best layer-0 window of `bundleIdentifier`, or nil.
    public static func pngData(bundleIdentifier: String) -> Data? {
        guard let image = cgImage(bundleIdentifier: bundleIdentifier) else { return nil }
        return boundedScreenshotData(for: image, maxBytes: 900_000)
    }

    public static func pngData(pid: pid_t) -> Data? {
        guard let image = cgImage(pid: pid) else { return nil }
        return boundedScreenshotData(for: image, maxBytes: 900_000)
    }

    private struct Candidate {
        let windowID: CGWindowID
        let bounds: CGRect
        let area: CGFloat
    }

    private static func preferredWindow(pid: pid_t) -> Candidate? {
        guard let infoList = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly],
            kCGNullWindowID
        ) as? [[String: Any]] else {
            return nil
        }

        var best: Candidate?
        for info in infoList {
            guard
                let ownerPID = info[kCGWindowOwnerPID as String] as? pid_t,
                ownerPID == pid,
                let number = info[kCGWindowNumber as String] as? NSNumber,
                let layer = info[kCGWindowLayer as String] as? Int,
                layer == 0,
                let boundsDictionary = info[kCGWindowBounds as String] as? NSDictionary,
                let bounds = CGRect(dictionaryRepresentation: boundsDictionary)
            else {
                continue
            }
            let area = bounds.width * bounds.height
            guard area >= 20_000 else { continue }
            if best == nil || area > best!.area {
                best = Candidate(
                    windowID: CGWindowID(number.uint32Value),
                    bounds: bounds,
                    area: area
                )
            }
        }
        return best
    }
}
