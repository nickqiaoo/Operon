import Foundation

/// Decision for Codex `syntheticallyActivateIfNeededForSendingClick`.
public struct ClickActivationDecision: Equatable, Sendable {
    /// Call `enforceActiveState` / `reassertActiveState`.
    public var shouldActivate: Bool
    /// Clear sticky belief and re-post (web / selection / wrong window).
    public var shouldReassert: Bool

    public init(shouldActivate: Bool, shouldReassert: Bool) {
        self.shouldActivate = shouldActivate
        self.shouldReassert = shouldReassert
    }

    public static let skip = ClickActivationDecision(shouldActivate: false, shouldReassert: false)
}

/// Pure gate matching the official decision order (architecture §1.8 + measured
/// Chromium behaviour). No I/O — callers supply already-read facts.
///
/// Official chain (early exits → enforce):
/// 1. enforcer state (frontmost / sticky ready)
/// 2. isCatalystApp
/// 3. clickingMayCauseSelection
/// 4. target window vs focused window CFEqual
/// 5. else enforceActiveState
public enum ClickActivationGate {
    public static func decide(
        enforcerState: SyntheticFocusState,
        isCatalystApp: Bool,
        isInsideWebView: Bool,
        clickingByCoordinate: Bool,
        clickingMayCauseSelection: Bool,
        /// `true` if AX focused window is the interaction target; `nil` if unknown.
        targetWindowIsFocusedWindow: Bool?
    ) -> ClickActivationDecision {
        // Real frontmost — macOS already delivered activation.
        if enforcerState.applicationIsActive {
            return .skip
        }

        // Web content & coordinate clicks: always re-arm (Chromium AXPress /
        // hit-testing need a fresh process-local activation).
        if isInsideWebView || clickingByCoordinate {
            return ClickActivationDecision(shouldActivate: true, shouldReassert: true)
        }

        // Catalyst UIKit apps need synth activation when background.
        if isCatalystApp {
            let sticky =
                enforcerState.applicationBelievesItIsActive
                && enforcerState.applicationBelievesItHasFocus
            return ClickActivationDecision(
                shouldActivate: true,
                shouldReassert: sticky
            )
        }

        let stickyReady =
            enforcerState.applicationBelievesItIsActive
            && enforcerState.applicationBelievesItHasFocus

        if stickyReady {
            // Click may move caret / selection — reassert.
            if clickingMayCauseSelection {
                return ClickActivationDecision(shouldActivate: true, shouldReassert: true)
            }
            // Target window is not the focused one — reassert.
            if targetWindowIsFocusedWindow == false {
                return ClickActivationDecision(shouldActivate: true, shouldReassert: true)
            }
            // Official steady state: already believes active+focus → no events.
            return .skip
        }

        // Not sticky-ready: post what's missing.
        return ClickActivationDecision(shouldActivate: true, shouldReassert: false)
    }
}
