import XCTest
@testable import OperonAccessibilitySupport

/// The behaviour these pin is the entire reason the enforcer exists: the common
/// path must post nothing. The previous implementation re-sent activation on
/// every action and on every accessibility settle, and that is what produced
/// the flicker.
final class FocusEnforcementPolicyTests: XCTestCase {
    func testColdStateAssertsBothActivationAndKeyFocus() {
        let decision = FocusEnforcementPolicy.decide(state: SyntheticFocusState())

        XCTAssertTrue(decision.postActivation)
        XCTAssertTrue(decision.postKeyFocusReturned)
    }

    func testSteadyStateIsANoOp() {
        let state = SyntheticFocusState(
            applicationBelievesItIsActive: true,
            applicationBelievesItHasFocus: true
        )

        XCTAssertTrue(FocusEnforcementPolicy.decide(state: state).isNoOp)
    }

    func testGenuinelyActiveApplicationNeedsNothingSynthetic() {
        let state = SyntheticFocusState(applicationIsActive: true)

        XCTAssertTrue(
            FocusEnforcementPolicy.decide(state: state).isNoOp,
            "an app that really is frontmost must not be sent synthetic activation"
        )
    }

    func testOnlyTheMissingHalfIsPosted() {
        let activeButUnfocused = SyntheticFocusState(applicationBelievesItIsActive: true)
        let focusedButInactive = SyntheticFocusState(applicationBelievesItHasFocus: true)

        let first = FocusEnforcementPolicy.decide(state: activeButUnfocused)
        XCTAssertFalse(first.postActivation)
        XCTAssertTrue(first.postKeyFocusReturned)

        let second = FocusEnforcementPolicy.decide(state: focusedButInactive)
        XCTAssertTrue(second.postActivation)
        XCTAssertFalse(second.postKeyFocusReturned)
    }

    func testEnforcingTwiceInARowPostsNothingTheSecondTime() {
        var state = SyntheticFocusState()

        let first = FocusEnforcementPolicy.decide(state: state)
        state = FocusEnforcementPolicy.applied(first, to: state)
        let second = FocusEnforcementPolicy.decide(state: state)

        XCTAssertFalse(first.isNoOp)
        XCTAssertTrue(second.isNoOp, "this is the property the whole state machine is for")
    }

    // A background target keeps its synthetic belief while the user moves
    // between other apps; otherwise the steady state would never be reached.
    func testSwitchingBetweenUnrelatedAppsDoesNotInvalidateBelief() {
        let state = SyntheticFocusState(
            applicationBelievesItIsActive: true,
            applicationBelievesItHasFocus: true
        )

        let updated = FocusEnforcementPolicy.frontmostChanged(
            to: 555,
            target: 42,
            state: state
        )

        XCTAssertFalse(updated.applicationIsActive)
        XCTAssertTrue(updated.applicationBelievesItIsActive)
        XCTAssertTrue(updated.applicationBelievesItHasFocus)
        XCTAssertTrue(FocusEnforcementPolicy.decide(state: updated).isNoOp)
    }

    // The one case macOS really does deliver a deactivate to the target.
    func testRealDeactivationInvalidatesBelief() {
        let state = SyntheticFocusState(
            applicationIsActive: true,
            applicationBelievesItIsActive: true,
            applicationBelievesItHasFocus: true
        )

        let updated = FocusEnforcementPolicy.frontmostChanged(
            to: 555,
            target: 42,
            state: state
        )

        XCTAssertFalse(updated.applicationBelievesItIsActive)
        XCTAssertFalse(updated.applicationBelievesItHasFocus)
        XCTAssertFalse(
            FocusEnforcementPolicy.decide(state: updated).isNoOp,
            "after a real deactivation the belief has to be re-asserted"
        )
    }

    func testRealActivationSupersedesSyntheticState() {
        let updated = FocusEnforcementPolicy.frontmostChanged(
            to: 42,
            target: 42,
            state: SyntheticFocusState()
        )

        XCTAssertTrue(updated.applicationIsActive)
        XCTAssertTrue(updated.applicationBelievesItIsActive)
        XCTAssertTrue(updated.applicationBelievesItHasFocus)
    }

    func testAppliedIgnoresANoOpDecision() {
        let state = SyntheticFocusState(
            applicationBelievesItIsActive: true,
            applicationBelievesItHasFocus: true
        )

        XCTAssertEqual(
            FocusEnforcementPolicy.applied(FocusEnforcementDecision(), to: state),
            state
        )
    }
}

final class SyntheticAppFocusEnforcerTests: XCTestCase {
    // pid 0 is never a real target, so nothing is delivered anywhere; the point
    // is the state transitions, which are what callers depend on.
    func testFirstEnforcementActsAndSecondIsANoOp() {
        let enforcer = SyntheticAppFocusEnforcer(pid: 0)

        let first = enforcer.enforceActiveState()
        let second = enforcer.enforceActiveState()

        XCTAssertFalse(first.isNoOp)
        XCTAssertTrue(second.isNoOp)
        XCTAssertTrue(enforcer.currentState.applicationBelievesItIsActive)
        XCTAssertTrue(enforcer.currentState.applicationBelievesItHasFocus)
    }

    func testDeactivateClearsTheAssertedBelief() {
        let enforcer = SyntheticAppFocusEnforcer(pid: 0)
        enforcer.enforceActiveState()

        enforcer.deactivateFocusEnforcer()

        XCTAssertFalse(enforcer.currentState.applicationBelievesItIsActive)
        XCTAssertFalse(enforcer.currentState.applicationBelievesItHasFocus)
        // And it becomes enforceable again rather than being left wedged.
        XCTAssertFalse(enforcer.enforceActiveState().isNoOp)
    }

    func testDeactivateWithoutPriorEnforcementIsHarmless() {
        let enforcer = SyntheticAppFocusEnforcer(pid: 0)

        enforcer.deactivateFocusEnforcer()
        enforcer.deactivateFocusEnforcer()

        XCTAssertFalse(enforcer.currentState.applicationBelievesItIsActive)
    }

    func testReassertPostsAgainAfterSteadyState() {
        let enforcer = SyntheticAppFocusEnforcer(pid: 0)
        XCTAssertFalse(enforcer.enforceActiveState().isNoOp)
        XCTAssertTrue(enforcer.enforceActiveState().isNoOp)

        let reasserted = enforcer.reassertActiveState(windowID: 42)
        XCTAssertFalse(reasserted.isNoOp)
        XCTAssertTrue(enforcer.currentState.applicationBelievesItIsActive)
        XCTAssertTrue(enforcer.currentState.applicationBelievesItHasFocus)
    }
}
