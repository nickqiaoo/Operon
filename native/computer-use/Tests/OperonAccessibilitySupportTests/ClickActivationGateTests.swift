import XCTest
@testable import OperonAccessibilitySupport

final class ClickActivationGateTests: XCTestCase {
    func testFrontmostSkips() {
        let state = SyntheticFocusState(
            applicationIsActive: true,
            applicationBelievesItIsActive: true,
            applicationBelievesItHasFocus: true
        )
        let d = ClickActivationGate.decide(
            enforcerState: state,
            isCatalystApp: false,
            isInsideWebView: true,
            clickingByCoordinate: true,
            clickingMayCauseSelection: true,
            targetWindowIsFocusedWindow: false
        )
        XCTAssertEqual(d, .skip)
    }

    func testWebAlwaysReassertsWhenBackground() {
        let state = SyntheticFocusState()
        let d = ClickActivationGate.decide(
            enforcerState: state,
            isCatalystApp: false,
            isInsideWebView: true,
            clickingByCoordinate: false,
            clickingMayCauseSelection: false,
            targetWindowIsFocusedWindow: true
        )
        XCTAssertTrue(d.shouldActivate)
        XCTAssertTrue(d.shouldReassert)
    }

    func testStickyReadyNativeIsNoOp() {
        let state = SyntheticFocusState(
            applicationIsActive: false,
            applicationBelievesItIsActive: true,
            applicationBelievesItHasFocus: true
        )
        let d = ClickActivationGate.decide(
            enforcerState: state,
            isCatalystApp: false,
            isInsideWebView: false,
            clickingByCoordinate: false,
            clickingMayCauseSelection: false,
            targetWindowIsFocusedWindow: true
        )
        XCTAssertEqual(d, .skip)
    }

    func testStickyReadyButWrongWindowReasserts() {
        let state = SyntheticFocusState(
            applicationIsActive: false,
            applicationBelievesItIsActive: true,
            applicationBelievesItHasFocus: true
        )
        let d = ClickActivationGate.decide(
            enforcerState: state,
            isCatalystApp: false,
            isInsideWebView: false,
            clickingByCoordinate: false,
            clickingMayCauseSelection: false,
            targetWindowIsFocusedWindow: false
        )
        XCTAssertTrue(d.shouldActivate)
        XCTAssertTrue(d.shouldReassert)
    }

    func testSelectionClickReassertsWhenSticky() {
        let state = SyntheticFocusState(
            applicationIsActive: false,
            applicationBelievesItIsActive: true,
            applicationBelievesItHasFocus: true
        )
        let d = ClickActivationGate.decide(
            enforcerState: state,
            isCatalystApp: false,
            isInsideWebView: false,
            clickingByCoordinate: false,
            clickingMayCauseSelection: true,
            targetWindowIsFocusedWindow: true
        )
        XCTAssertTrue(d.shouldActivate)
        XCTAssertTrue(d.shouldReassert)
    }

    func testColdStartEnforcesWithoutReassert() {
        let state = SyntheticFocusState()
        let d = ClickActivationGate.decide(
            enforcerState: state,
            isCatalystApp: false,
            isInsideWebView: false,
            clickingByCoordinate: false,
            clickingMayCauseSelection: false,
            targetWindowIsFocusedWindow: nil
        )
        XCTAssertTrue(d.shouldActivate)
        XCTAssertFalse(d.shouldReassert)
    }
}
