import CoreGraphics
import XCTest
@testable import OperonAccessibilitySupport
@testable import OperonSystemSoftware

final class EventTapConfigurationTests: XCTestCase {
    func testDefaultsMatchTheOfficialProcessNotificationTap() {
        let tap = EventTap(eventTypes: CPSNotification.eventTypeMask)

        XCTAssertEqual(tap.eventTypes, 0x200000)
        XCTAssertEqual(tap.location, .annotatedSession)
        XCTAssertEqual(tap.placement, .tailAppendEventTap)
        XCTAssertEqual(
            tap.options,
            .defaultTap,
            "the official tap is active — a listen-only tap cannot swallow a focus transfer"
        )
        XCTAssertTrue(
            tap.shouldAutoreenable,
            "a tap silently disabled by timeout looks identical to 'focus stealing stopped'"
        )
    }

    func testIsNotMonitoringBeforeItStarts() {
        let tap = EventTap(eventTypes: CPSNotification.eventTypeMask)

        XCTAssertFalse(tap.isMonitoring)
        XCTAssertFalse(tap.isEnabled)
    }

    func testStopIsSafeWithoutStart() {
        let tap = EventTap(eventTypes: CPSNotification.eventTypeMask)

        tap.stopMonitoring()
        tap.stopMonitoring()

        XCTAssertFalse(tap.isMonitoring)
    }

    func testPerProcessLocationCarriesItsPID() {
        let tap = EventTap(eventTypes: CPSNotification.eventTypeMask, location: .pid(4242))

        XCTAssertEqual(tap.location, .pid(4242))
    }

    // The failure mode that matters: if a tap cannot be created (no
    // Accessibility/Input Monitoring grant), that has to be reported so the
    // caller degrades, not assumed to have worked.
    func testStartReportsWhetherTheTapWasActuallyInstalled() {
        let tap = EventTap(
            eventTypes: CPSNotification.eventTypeMask,
            location: .annotatedSession,
            options: .listenOnly
        )

        let started = tap.startMonitoring { _, event in event }

        XCTAssertEqual(started, tap.isMonitoring)
        tap.stopMonitoring()
        XCTAssertFalse(tap.isMonitoring)
    }
}
