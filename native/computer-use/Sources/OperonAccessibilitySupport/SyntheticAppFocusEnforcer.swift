import AppKit
import CoreGraphics
import Foundation
import OperonSystemSoftware

/// The three-way state the official `SyntheticAppFocusEnforcer` keeps per pid.
///
/// The distinction that makes the whole thing work: an app that *really* is
/// frontmost needs nothing from us, while an app that has merely been told it
/// is active needs that belief maintained — and re-asserting it on every action
/// is what produces the flicker this work exists to remove.
public struct SyntheticFocusState: Equatable, Sendable {
    /// The target genuinely is the frontmost application.
    public var applicationIsActive = false
    /// The target has been told it is active and has not been told otherwise.
    public var applicationBelievesItIsActive = false
    /// The target has been told its window holds key focus.
    public var applicationBelievesItHasFocus = false

    public init(
        applicationIsActive: Bool = false,
        applicationBelievesItIsActive: Bool = false,
        applicationBelievesItHasFocus: Bool = false
    ) {
        self.applicationIsActive = applicationIsActive
        self.applicationBelievesItIsActive = applicationBelievesItIsActive
        self.applicationBelievesItHasFocus = applicationBelievesItHasFocus
    }
}

/// What `enforceActiveState` should post, given the current state.
public struct FocusEnforcementDecision: Equatable, Sendable {
    public var postActivation = false
    public var postKeyFocusReturned = false

    public var isNoOp: Bool {
        !postActivation && !postKeyFocusReturned
    }

    public init(postActivation: Bool = false, postKeyFocusReturned: Bool = false) {
        self.postActivation = postActivation
        self.postKeyFocusReturned = postKeyFocusReturned
    }
}

/// The decision half of the enforcer, kept pure so it can be tested without a
/// live target process. Every rule here is a behaviour we want pinned, not an
/// implementation detail.
public enum FocusEnforcementPolicy {
    /// Mirrors the official early-return: if the target already believes it is
    /// active *and* focused, nothing is posted at all.
    public static func decide(state: SyntheticFocusState) -> FocusEnforcementDecision {
        // A genuinely frontmost app needs no synthetic anything.
        if state.applicationIsActive {
            return FocusEnforcementDecision()
        }
        if state.applicationBelievesItIsActive, state.applicationBelievesItHasFocus {
            return FocusEnforcementDecision()
        }
        return FocusEnforcementDecision(
            postActivation: !state.applicationBelievesItIsActive,
            postKeyFocusReturned: !state.applicationBelievesItHasFocus
        )
    }

    /// State after a successful enforcement.
    public static func applied(
        _ decision: FocusEnforcementDecision,
        to state: SyntheticFocusState
    ) -> SyntheticFocusState {
        guard !decision.isNoOp else {
            return state
        }
        var updated = state
        if decision.postActivation {
            updated.applicationBelievesItIsActive = true
        }
        if decision.postKeyFocusReturned {
            updated.applicationBelievesItHasFocus = true
        }
        return updated
    }

    /// State after the real frontmost application changed.
    ///
    /// Only a genuine deactivation — the target really was frontmost and no
    /// longer is — invalidates the synthetic belief, because that is the only
    /// case where macOS itself delivered a deactivate to the target. Switching
    /// between two unrelated apps leaves a background target's belief intact,
    /// which is what keeps the steady state free of redundant events.
    public static func frontmostChanged(
        to frontmostPID: pid_t,
        target: pid_t,
        state: SyntheticFocusState
    ) -> SyntheticFocusState {
        var updated = state
        let isNowActive = frontmostPID == target
        let wasReallyActive = state.applicationIsActive
        updated.applicationIsActive = isNowActive

        if isNowActive {
            // Real activation supersedes anything synthetic.
            updated.applicationBelievesItIsActive = true
            updated.applicationBelievesItHasFocus = true
        } else if wasReallyActive {
            updated.applicationBelievesItIsActive = false
            updated.applicationBelievesItHasFocus = false
        }
        return updated
    }
}

/// Long-lived, one per target process.
///
/// Created when a Computer Use session for an app begins and torn down when it
/// ends — never per action. That lifetime is the point: the state it carries is
/// what lets `enforceActiveState` do nothing on the common path.
public final class SyntheticAppFocusEnforcer {
    public let pid: pid_t

    private let lock = NSLock()
    private var state = SyntheticFocusState()
    private let tracker: SystemFrontmostApplicationTracker
    private var observer: SystemFrontmostApplicationTracker.Observer?

    public init(
        pid: pid_t,
        tracker: SystemFrontmostApplicationTracker = SystemFrontmostApplicationTracker()
    ) {
        self.pid = pid
        self.tracker = tracker

        lock.withLock {
            state.applicationIsActive = tracker.isFrontmost(pid: pid)
            if state.applicationIsActive {
                state.applicationBelievesItIsActive = true
                state.applicationBelievesItHasFocus = true
            }
        }

        // Codex always pairs an enforcer with SystemFocusStealPreventer for the
        // same pid (edge-case backstop if the target tries to become real front).
        SystemFocusStealPreventer.startPreventingFocusStealing(
            for: pid,
            targetLostFocusHandler: { [weak self] in
                guard let self else { return }
                lock.withLock {
                    state.applicationBelievesItHasFocus = false
                }
            },
            targetGainedFocusHandler: { [weak self] in
                guard let self else { return }
                lock.withLock {
                    state.applicationBelievesItHasFocus = true
                }
            }
        )

        observer = tracker.addObserver { [weak self] application in
            guard let self else {
                return
            }
            lock.withLock {
                state = FocusEnforcementPolicy.frontmostChanged(
                    to: application.processIdentifier,
                    target: pid,
                    state: state
                )
            }
        }
    }

    deinit {
        observer.map(tracker.removeObserver)
        SystemFocusStealPreventer.stopPreventingFocusStealing(for: pid)
    }

    public var currentState: SyntheticFocusState {
        lock.withLock { state }
    }

    /// Posts only what the current state is missing, and nothing at all once
    /// the target already believes it is active and focused.
    ///
    /// Returns the decision that was acted on, so callers (and tests) can see
    /// that the steady state really is a no-op rather than assuming it.
    @discardableResult
    public func enforceActiveState(
        windowID: CGWindowID = 0,
        windowBounds: CGRect? = nil
    ) -> FocusEnforcementDecision {
        let decision = lock.withLock { FocusEnforcementPolicy.decide(state: state) }
        guard !decision.isNoOp else {
            return decision
        }

        if decision.postActivation {
            let sequence = SynthesizedFocusEvent.appActivatedSequence(
                windowID: windowID,
                windowBounds: windowBounds
            )
            if sequence.isEmpty {
                SynthesizedFocusEvent.appActivated(windowID: windowID)?.send(to: pid)
            } else {
                for event in sequence {
                    event.send(to: pid)
                }
            }
        }
        if decision.postKeyFocusReturned {
            SynthesizedFocusEvent.windowKeyFocusReturned()?.send(to: pid)
        }

        lock.withLock {
            state = FocusEnforcementPolicy.applied(decision, to: state)
        }
        return decision
    }

    /// Re-post synthetic activation / key-focus even when the enforcer is already
    /// in the sticky steady state.
    ///
    /// Needed before web-content actions: Chromium often reports `AXPress`
    /// success without running the page handler unless the process has just
    /// received process-local activation. Steady-state no-op is correct for
    /// repeated native AX work, but not for re-arming Electron web clicks.
    @discardableResult
    public func reassertActiveState(
        windowID: CGWindowID = 0,
        windowBounds: CGRect? = nil
    ) -> FocusEnforcementDecision {
        lock.withLock {
            state.applicationBelievesItIsActive = false
            state.applicationBelievesItHasFocus = false
        }
        return enforceActiveState(windowID: windowID, windowBounds: windowBounds)
    }

    /// Codex `ApplicationUIElement.waitUntilAppBelievesItIsFrontmost(timeout:)`
    ///. Called from `sendClick` after
    /// `enforceActiveState` with **`timeout: 2.0`** (`fmov d0, #2.0`).
    ///
    /// The official loop asks the **target** whether it believes it is frontmost:
    /// each iteration calls `AXUIElementRef.value(for:)` with
    /// `AccessibilitySupport.UIElementAttribute.frontmost`, meaning it reads the
    /// target app element's `AXFrontmost`.
    ///
    /// Our previous version polled **our own** `applicationBelievesIt*` flags —
    /// flags this class sets itself right after posting the activation events. It
    /// could therefore never observe a failure, which made it a ~0.1s sleep with
    /// extra steps. `AXFrontmost` does track: measured 0 before enforcement and 1
    /// after, while the real system frontmost never moved.
    public func waitUntilAppBelievesItIsFrontmost(timeout: TimeInterval = 2.0) {
        let start = Date()
        let deadline = start.addingTimeInterval(max(timeout, 0))
        // Floor so we never fire mouse events in the same runloop turn as the
        // activation posts (Electron needs a beat to arm hit-testing).
        let minimumSettle: TimeInterval = 0.1
        while true {
            let now = Date()
            let elapsed = now.timeIntervalSince(start)
            if elapsed >= minimumSettle {
                // Real frontmost short-circuit: nothing to wait for.
                if currentState.applicationIsActive {
                    return
                }
                // Ask the target, not ourselves.
                if targetReportsItIsFrontmost() {
                    return
                }
            }
            if now >= deadline {
                return
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
    }

    /// `AXFrontmost` on the target's application element — what the app itself
    /// believes, independent of the system's real front process.
    private func targetReportsItIsFrontmost() -> Bool {
        var value: CFTypeRef?
        let element = AXUIElementCreateApplication(pid)
        guard AXUIElementCopyAttributeValue(
            element,
            kAXFrontmostAttribute as CFString,
            &value
        ) == .success else {
            // Attribute unreadable (app gone, AX not enabled): fall back to the
            // sticky belief rather than blocking for the full timeout.
            let state = currentState
            return state.applicationBelievesItIsActive && state.applicationBelievesItHasFocus
        }
        return (value as? Bool) ?? false
    }

    /// Re-reads the real frontmost application. Called after a synthesized
    /// action in case it caused a genuine activation.
    public func synthesizedActionWasPerformed() {
        let isActive = tracker.isFrontmost(pid: pid)
        lock.withLock {
            state = FocusEnforcementPolicy.frontmostChanged(
                to: isActive ? pid : -1,
                target: pid,
                state: state
            )
        }
    }

    /// Hands the target back to a clean state at end of session.
    ///
    /// Only sends the deactivation when a synthetic activation was actually
    /// asserted; telling an app it was deactivated when we never activated it
    /// would be a change the user can see.
    public func deactivateFocusEnforcer() {
        SystemFocusStealPreventer.stopSuppressingMenuDismissalEvents(for: pid)
        SystemFocusStealPreventer.stopPreventingFocusStealing(for: pid)
        let shouldDeactivate = lock.withLock {
            let asserted = state.applicationBelievesItIsActive && !state.applicationIsActive
            if asserted {
                state.applicationBelievesItIsActive = false
                state.applicationBelievesItHasFocus = false
            }
            return asserted
        }
        guard shouldDeactivate else {
            return
        }
        SynthesizedFocusEvent.windowKeyFocusRemoved()?.send(to: pid)
        SynthesizedFocusEvent.appDeactivated()?.send(to: pid)
    }

    /// Codex `SyntheticAppFocusEnforcer.startSuppressingMenuDismissalEvents`.
    public func startSuppressingMenuDismissalEvents(menuPID: pid_t?) {
        SystemFocusStealPreventer.startSuppressingMenuDismissalEvents(for: pid, menuPID: menuPID)
    }

    public func stopSuppressingMenuDismissalEvents() {
        SystemFocusStealPreventer.stopSuppressingMenuDismissalEvents(for: pid)
    }
}
