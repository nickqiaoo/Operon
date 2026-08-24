import XCTest
import OpenComputerUseKit

// [operon] Pure-function tests for the line-level diff in get_app_state (no AX involved).
final class DiffTests: XCTestCase {
    func testAddedRemovedChanged() {
        let prev = "0 Window\n1 Button A\n2 Field"
        let curr = "0 Window\n1 Button B\n2 Field\n3 New"
        let diff = ComputerUseService.renderAccessibilityDiff(previous: prev, current: curr)
        XCTAssertTrue(diff.contains("[added/changed]"))
        XCTAssertTrue(diff.contains("1 Button B")) // changed → new line
        XCTAssertTrue(diff.contains("3 New")) // added
        XCTAssertTrue(diff.contains("[removed]"))
        XCTAssertTrue(diff.contains("1 Button A")) // old line goes to removed
        XCTAssertFalse(diff.contains("2 Field\n2 Field")) // unchanged lines are not listed twice
    }

    func testNoChange() {
        let s = "0 Window\n1 Button"
        let diff = ComputerUseService.renderAccessibilityDiff(previous: s, current: s)
        XCTAssertTrue(diff.contains("no accessibility changes"))
    }

    func testDisableDiffSemanticsAreCallerSide() {
        // renderAccessibilityDiff is only called when disableDiff=false and a previous snapshot
        // exists (see getAppState). All this checks is that the diff really contains only what
        // changed, and no unchanged elements.
        let prev = "0 A\n1 B\n2 C"
        let curr = "0 A\n1 B\n2 C\n3 D"
        let diff = ComputerUseService.renderAccessibilityDiff(previous: prev, current: curr)
        XCTAssertTrue(diff.contains("3 D"))
        XCTAssertFalse(diff.contains("\n0 A")) // unchanged elements stay out of the diff body
    }
}
