import CoreGraphics
import XCTest
@testable import OpenComputerUseKit

final class CodexParityTests: XCTestCase {
    func testSyntheticApplicationActivationUsesAppKitActivatedSubtype() {
        XCTAssertEqual(syntheticApplicationActivatedEventSubtype, 1)
        XCTAssertEqual(syntheticApplicationDeactivatedEventSubtype, 2)
        XCTAssertEqual(syntheticProcessNotificationEventTypeRawValue, 0x15)
        XCTAssertEqual(
            UInt16(bitPattern: syntheticWindowKeyFocusReturnedSubtype),
            0x8000
        )
    }

    func testTargetedPointerEventCarriesTheDestinationWindow() throws {
        guard let event = CGEvent(
            mouseEventSource: nil,
            mouseType: .leftMouseDown,
            mouseCursorPosition: CGPoint(x: 10, y: 20),
            mouseButton: .left
        ) else {
            XCTFail("Could not create mouse event")
            return
        }

        InputSimulation.applyTargetWindow(42, to: event)

        XCTAssertEqual(event.getIntegerValueField(.mouseEventSubtype), 3)
        XCTAssertEqual(
            event.getIntegerValueField(.mouseEventWindowUnderMousePointer),
            42
        )
        XCTAssertEqual(
            event.getIntegerValueField(
                .mouseEventWindowUnderMousePointerThatCanHandleThisEvent
            ),
            42
        )
    }

    func testTargetedPointerUsesAWindowNumberedAppKitEvent() throws {
        let event = try XCTUnwrap(
            InputSimulation.targetedWindowMouseEvent(
                type: .leftMouseDown,
                point: CGPoint(x: 130, y: 240),
                button: .left,
                clickState: 1,
                windowID: 42,
                windowBounds: CGRect(
                    x: 100,
                    y: 200,
                    width: 500,
                    height: 400
                ),
                windowUsesFlippedCoordinates: true
            )
        )

        XCTAssertEqual(event.location, CGPoint(x: 130, y: 240))
        XCTAssertEqual(
            event.getIntegerValueField(.mouseEventNumber),
            1
        )
    }

    func testWindowLocalPointFlippedMatchesCGTopLeft() {
        let bounds = CGRect(x: 100, y: 200, width: 500, height: 400)
        let global = CGPoint(x: 150, y: 250)
        let local = windowLocalPoint(
            globalPoint: global,
            windowBounds: bounds,
            windowUsesFlippedCoordinates: true
        )
        XCTAssertEqual(local, CGPoint(x: 50, y: 50))
    }

    func testWindowLocalPointUnflippedUsesBottomOrigin() {
        let bounds = CGRect(x: 100, y: 200, width: 500, height: 400)
        let global = CGPoint(x: 150, y: 250)
        let local = windowLocalPoint(
            globalPoint: global,
            windowBounds: bounds,
            windowUsesFlippedCoordinates: false
        )
        // yFromTop = 50 → bottom-origin y = 400 - 50 = 350
        XCTAssertEqual(local, CGPoint(x: 50, y: 350))
    }

    func testSparseElectronTreeWaitsForWebAccessibility() {
        let enabled = AccessibilityEnablementState(
            manualAccessibilityEnabled: true,
            enhancedUserInterfaceEnabled: true
        )

        XCTAssertTrue(
            shouldSettleWebAccessibility(enablement: enabled)
        )
    }

    func testHydratedElectronTreeStillGetsASettleWindow() {
        let enabled = AccessibilityEnablementState(
            manualAccessibilityEnabled: true,
            enhancedUserInterfaceEnabled: true
        )

        XCTAssertTrue(shouldSettleWebAccessibility(enablement: enabled))
    }

    func testNativeTreeDoesNotPayElectronSettleDelay() {
        let unsupported = AccessibilityEnablementState(
            manualAccessibilityEnabled: false,
            enhancedUserInterfaceEnabled: true
        )

        XCTAssertFalse(
            shouldSettleWebAccessibility(enablement: unsupported)
        )
    }

    func testScreenshotWaitKeepsTheMainRunLoopResponsive() {
        let completion = DispatchSemaphore(value: 0)
        DispatchQueue.main.async {
            completion.signal()
        }

        XCTAssertTrue(
            waitForScreenCaptureCompletion(completion, timeout: 0.1)
        )
    }

    func testElementRefetchPrefersStableIdentifier() {
        let previous = AccessibilityElementIdentity(
            identifier: "message-list",
            role: "AXList",
            title: "Messages",
            localFrame: CGRect(x: 10, y: 20, width: 300, height: 500),
            isSyntheticText: false
        )
        let moved = AccessibilityElementIdentity(
            identifier: "message-list",
            role: "AXList",
            title: "Messages",
            localFrame: CGRect(x: 14, y: 20, width: 300, height: 500),
            isSyntheticText: false
        )
        let different = AccessibilityElementIdentity(
            identifier: "settings-list",
            role: "AXList",
            title: "Messages",
            localFrame: CGRect(x: 14, y: 20, width: 300, height: 500),
            isSyntheticText: false
        )

        XCTAssertNotNil(
            accessibilityElementRefetchScore(
                previous: previous,
                candidate: moved
            )
        )
        XCTAssertNil(
            accessibilityElementRefetchScore(
                previous: previous,
                candidate: different
            )
        )
    }

    func testElementRefetchRejectsDifferentRoleOrDistantFrame() {
        let previous = AccessibilityElementIdentity(
            identifier: nil,
            role: "AXButton",
            title: "Open",
            localFrame: CGRect(x: 20, y: 20, width: 80, height: 28),
            isSyntheticText: false
        )
        let differentRole = AccessibilityElementIdentity(
            identifier: nil,
            role: "AXStaticText",
            title: "Open",
            localFrame: CGRect(x: 20, y: 20, width: 80, height: 28),
            isSyntheticText: false
        )
        let distant = AccessibilityElementIdentity(
            identifier: nil,
            role: "AXButton",
            title: "Open",
            localFrame: CGRect(x: 600, y: 400, width: 80, height: 28),
            isSyntheticText: false
        )

        XCTAssertNil(
            accessibilityElementRefetchScore(
                previous: previous,
                candidate: differentRole
            )
        )
        XCTAssertNil(
            accessibilityElementRefetchScore(
                previous: previous,
                candidate: distant
            )
        )
    }

    func testWindowBindingUsesAXFrameWhenTitlesAreIdentical() {
        let frontWindow = WindowCaptureCandidate(
            windowID: 10,
            layer: 0,
            bounds: CGRect(x: 0, y: 0, width: 900, height: 700),
            title: "QQ",
            area: 630_000,
            frontToBackIndex: 0
        )
        let targetWindow = WindowCaptureCandidate(
            windowID: 11,
            layer: 0,
            bounds: CGRect(x: 980, y: 40, width: 700, height: 600),
            title: "QQ",
            area: 420_000,
            frontToBackIndex: 1
        )

        XCTAssertEqual(
            preferredWindowCaptureCandidate(
                [frontWindow, targetWindow],
                titleHint: "QQ",
                frameHint: CGRect(x: 980, y: 40, width: 700, height: 600)
            )?.windowID,
            11
        )
    }

    func testWindowBootstrapPrefersVisibleWindowOverStaleFrontOrderedWindow() {
        let staleWindow = WindowCaptureCandidate(
            windowID: 20,
            layer: 0,
            bounds: CGRect(x: 560, y: 184, width: 800, height: 600),
            title: "QQ",
            area: 480_000,
            frontToBackIndex: 2
        )
        let visibleMainWindow = WindowCaptureCandidate(
            windowID: 21,
            layer: 0,
            bounds: CGRect(x: 558, y: 137, width: 974, height: 731),
            title: "QQ",
            area: 711_994,
            frontToBackIndex: 40,
            isOnScreen: true
        )

        XCTAssertEqual(
            preferredWindowCaptureCandidate(
                [staleWindow, visibleMainWindow],
                titleHint: "QQ",
                frameHint: staleWindow.bounds
            )?.windowID,
            21
        )
    }
}
