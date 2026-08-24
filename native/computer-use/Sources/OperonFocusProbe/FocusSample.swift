import Foundation

/// The four independent answers to "which process is in front right now".
///
/// They are recorded separately because the whole point of background Computer
/// Use is to make them disagree in a specific way: `keyFocus` (and possibly
/// `cpsFront`) moves to the target while `workspaceFront` and `topWindow` stay
/// on whatever the user was using. A implementation that steals the foreground
/// moves all four.
public struct FocusSignature: Equatable, Hashable, Codable, Sendable {
    /// What AppKit — and therefore the user, the Dock and every other app —
    /// considers frontmost.
    public var workspaceFrontPID: pid_t?
    /// The CPS-level front process, which `_SLPSSetFrontProcessWithOptions`
    /// is what actually writes.
    public var cpsFrontPID: pid_t?
    /// The process holding key focus, i.e. where typed input would land.
    public var keyFocusPID: pid_t?
    /// Owner of the frontmost normal-layer on-screen window, i.e. what is
    /// visibly on top regardless of what the process tables claim.
    public var topWindowPID: pid_t?

    public init(
        workspaceFrontPID: pid_t? = nil,
        cpsFrontPID: pid_t? = nil,
        keyFocusPID: pid_t? = nil,
        topWindowPID: pid_t? = nil
    ) {
        self.workspaceFrontPID = workspaceFrontPID
        self.cpsFrontPID = cpsFrontPID
        self.keyFocusPID = keyFocusPID
        self.topWindowPID = topWindowPID
    }
}

/// One emitted line of the timeline. Samples are taken continuously but only
/// recorded when the signature changes, so a record marks a transition.
public struct FocusRecord: Equatable, Codable, Sendable {
    public var elapsedMilliseconds: Double
    public var signature: FocusSignature
    /// pid → process name for every pid named in this record, so the JSONL is
    /// readable without a second lookup pass.
    public var names: [String: String]

    public init(
        elapsedMilliseconds: Double,
        signature: FocusSignature,
        names: [String: String] = [:]
    ) {
        self.elapsedMilliseconds = elapsedMilliseconds
        self.signature = signature
        self.names = names
    }
}

/// A contiguous stretch of time during which one field held one value.
public struct FocusEpisode: Equatable, Sendable {
    public var pid: pid_t?
    public var startMilliseconds: Double
    public var endMilliseconds: Double

    public var durationMilliseconds: Double {
        endMilliseconds - startMilliseconds
    }

    public init(pid: pid_t?, startMilliseconds: Double, endMilliseconds: Double) {
        self.pid = pid
        self.startMilliseconds = startMilliseconds
        self.endMilliseconds = endMilliseconds
    }
}

/// Pure analysis over a recorded timeline. Kept free of AppKit and of the
/// sampler so the acceptance criteria can be asserted in unit tests against
/// synthetic timelines.
public enum FocusProbeReport {
    /// Collapses the transition records of one field into episodes.
    public static func episodes(
        in records: [FocusRecord],
        totalMilliseconds: Double,
        field: KeyPath<FocusSignature, pid_t?>
    ) -> [FocusEpisode] {
        var episodes: [FocusEpisode] = []
        for record in records {
            let pid = record.signature[keyPath: field]
            if var last = episodes.last, last.pid == pid {
                last.endMilliseconds = totalMilliseconds
                episodes[episodes.count - 1] = last
                continue
            }
            if !episodes.isEmpty {
                episodes[episodes.count - 1].endMilliseconds = record.elapsedMilliseconds
            }
            episodes.append(
                FocusEpisode(
                    pid: pid,
                    startMilliseconds: record.elapsedMilliseconds,
                    endMilliseconds: totalMilliseconds
                )
            )
        }
        return episodes
    }

    /// Acceptance criterion 1: the visible foreground never left `baselinePID`.
    ///
    /// Returns every stretch where it did. An empty result is the pass
    /// condition; a 30 ms blip is exactly the failure the probe exists to catch,
    /// so no minimum duration is applied.
    public static func foreignForegroundEpisodes(
        in records: [FocusRecord],
        totalMilliseconds: Double,
        baselinePID: pid_t
    ) -> [FocusEpisode] {
        let visible = episodes(
            in: records,
            totalMilliseconds: totalMilliseconds,
            field: \.workspaceFrontPID
        ) + episodes(
            in: records,
            totalMilliseconds: totalMilliseconds,
            field: \.topWindowPID
        )
        return visible
            .filter { $0.pid != baselinePID }
            .sorted { $0.startMilliseconds < $1.startMilliseconds }
    }
}
