import AppKit
import CoreGraphics
import Foundation
import OperonSystemSoftware

/// High-frequency sampler of the four foreground signals.
///
/// Phase 0 of the background-focus work: before any mechanism changes, there
/// has to be an objective record of whether the foreground moved, because
/// "did it flicker" is otherwise a judgement call made by watching a screen.
public final class FocusProbe {
    public struct Options {
        public var intervalMilliseconds: Double = 10
        public var durationSeconds: Double?
        /// Emit every sample rather than only transitions. Useful when
        /// correlating against an external log by wall-clock density.
        public var emitEverySample = false

        public init() {}
    }

    private let options: Options
    private let resolver = ProcessSerialNumberResolver()
    private var nameCache: [pid_t: String] = [:]
    private var records: [FocusRecord] = []
    private var lastSignature: FocusSignature?
    private var sampleCount = 0

    public private(set) var availability = ApplicationRegistrySPI.Availability()

    public init(options: Options = Options()) {
        self.options = options
    }

    /// Runs until `durationSeconds` elapses or `shouldStop` returns true.
    /// `onRecord` fires for every emitted line so the caller can stream it out.
    @discardableResult
    public func run(
        shouldStop: () -> Bool,
        onRecord: (FocusRecord) -> Void
    ) -> (records: [FocusRecord], totalMilliseconds: Double) {
        availability = ApplicationRegistrySPI.probeAvailability()
        resolver.refresh()

        let start = DispatchTime.now().uptimeNanoseconds
        let interval = max(options.intervalMilliseconds, 1) / 1000
        var nextTick = Date().timeIntervalSinceReferenceDate

        while !shouldStop() {
            let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
            if let duration = options.durationSeconds, elapsed >= duration * 1000 {
                break
            }

            let signature = sample()
            sampleCount += 1
            if options.emitEverySample || signature != lastSignature {
                lastSignature = signature
                let record = FocusRecord(
                    elapsedMilliseconds: elapsed,
                    signature: signature,
                    names: names(for: signature)
                )
                records.append(record)
                onRecord(record)
            }

            nextTick += interval
            let now = Date().timeIntervalSinceReferenceDate
            if nextTick > now {
                // The idle gap must be spent running the run loop, not sleeping.
                // `NSWorkspace.frontmostApplication` is notification-backed, so
                // without a pump it reports a stale value forever — which would
                // make every run pass regardless of what the foreground did.
                RunLoop.current.run(
                    mode: .default,
                    before: Date(timeIntervalSinceReferenceDate: nextTick)
                )
            } else {
                // Fell behind; resync rather than accumulate drift.
                nextTick = now
            }
        }

        let total = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
        return (records, total)
    }

    public var totalSamples: Int {
        sampleCount
    }

    private func sample() -> FocusSignature {
        var signature = FocusSignature()
        signature.workspaceFrontPID = NSWorkspace.shared.frontmostApplication?.processIdentifier

        if availability.canReadFrontProcess,
           let psn = ApplicationRegistrySPI.frontProcess() {
            signature.cpsFrontPID = availability.canResolveSerialNumbers
                ? resolver.pid(for: psn)
                : nil
        }
        if availability.canReadKeyFocusProcess,
           let focus = ApplicationRegistrySPI.keyFocusProcess() {
            signature.keyFocusPID = availability.canResolveSerialNumbers
                ? resolver.pid(for: focus.process)
                : nil
        }
        signature.topWindowPID = Self.frontmostWindowOwnerPID()
        return signature
    }

    /// Owner of the topmost normal-layer window. Layer 0 skips the menu bar,
    /// Dock, cursor overlays and other chrome that would otherwise always win.
    public static func frontmostWindowOwnerPID() -> pid_t? {
        guard let infoList = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else {
            return nil
        }

        for info in infoList {
            guard let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
                  let pid = info[kCGWindowOwnerPID as String] as? pid_t,
                  let boundsDictionary = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDictionary),
                  bounds.width > 1, bounds.height > 1
            else {
                continue
            }
            return pid
        }
        return nil
    }

    private func names(for signature: FocusSignature) -> [String: String] {
        var result: [String: String] = [:]
        for pid in [
            signature.workspaceFrontPID,
            signature.cpsFrontPID,
            signature.keyFocusPID,
            signature.topWindowPID,
        ].compactMap({ $0 }) {
            result[String(pid)] = name(for: pid)
        }
        return result
    }

    private func name(for pid: pid_t) -> String {
        if let cached = nameCache[pid] {
            return cached
        }
        let application = NSRunningApplication(processIdentifier: pid)
        let resolved = application?.localizedName
            ?? application?.bundleIdentifier
            ?? "pid \(pid)"
        nameCache[pid] = resolved
        return resolved
    }
}
