import XCTest
@testable import OpenComputerUseKit
@testable import OperonComputerUseServer

/// Product-path guarantees for Codex-style background Computer Use.
final class BackgroundFocusPathTests: XCTestCase {
    func testFocusStealGuardIsAPassthrough() {
        var ran = false
        let value = FocusStealGuard.perform(app: "Finder") {
            ran = true
            return 42
        }
        XCTAssertTrue(ran)
        XCTAssertEqual(value, 42)
    }

    func testGlobalPointerFallbackIsOffByDefault() {
        XCTAssertFalse(
            globalPointerFallbacksEnabled(environment: [:])
        )
        XCTAssertFalse(
            globalPointerFallbacksEnabled(environment: [
                "OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS": "0",
            ])
        )
        XCTAssertTrue(
            globalPointerFallbacksEnabled(environment: [
                "OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS": "1",
            ])
        )
    }

    func testServiceExposesBackgroundFocusTeardown() {
        let service = ComputerUseService()
        // Must be safe with no active enforcers.
        service.endAllBackgroundFocusSessions()
        service.endAllBackgroundFocusSessions()
    }

    func testDispatcherForwardsBackgroundFocusTeardown() {
        let dispatcher = ComputerUseToolDispatcher()
        dispatcher.endBackgroundFocusSessions()
    }
}
