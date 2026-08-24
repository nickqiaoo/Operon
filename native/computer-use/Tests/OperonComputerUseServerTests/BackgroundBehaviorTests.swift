import AppKit
import ScreenCaptureKit
import XCTest
@testable import OpenComputerUseKit
@testable import OperonComputerUseServer

final class BackgroundBehaviorTests: XCTestCase {
    func testStatusMenuOnlyHasContentForAnActiveSession() {
        XCTAssertEqual(
            computerUseStatusMenuTitles(activeDisplayName: nil),
            []
        )
        XCTAssertEqual(
            computerUseStatusMenuTitles(activeDisplayName: "System Settings"),
            ["System Settings", "Stop Computer Use for System Settings"]
        )
    }

    func testPresentationPublishesRemoteContextMetadataWithoutAnImage() throws {
        let scope = try XCTUnwrap(
            ComputerUseTurnScope(metadata: [
                "session_id": "session-1",
                "turn_id": "turn-1",
                "operon_session_id": "42",
            ])
        )
        let payload = computerUsePresentationPayload(
            type: "presentation",
            scope: scope,
            appReference: "QQ",
            bundleIdentifier: "com.tencent.qq",
            displayName: "QQ",
            contextID: 123,
            size: CGSize(width: 640, height: 480),
            reason: nil
        )

        XCTAssertEqual(payload["contextID"] as? UInt32, 123)
        XCTAssertEqual(payload["width"] as? Int, 640)
        XCTAssertEqual(payload["height"] as? Int, 480)
        XCTAssertNil(payload["screenshotURL"])
    }

    /// A session that cannot capture must say so — an empty PiP with no event is
    /// how a revoked Screen Recording grant went unnoticed for hours.
    func testBlockedPresentationCarriesAReasonAndNoContext() throws {
        let scope = try XCTUnwrap(
            ComputerUseTurnScope(metadata: [
                "session_id": "session-1",
                "turn_id": "turn-1",
                "operon_session_id": "42",
            ])
        )
        let payload = computerUsePresentationPayload(
            type: "blocked",
            scope: scope,
            appReference: "QQ",
            bundleIdentifier: "com.tencent.qq",
            displayName: "QQ",
            contextID: nil,
            size: nil,
            reason: "screen-recording"
        )

        XCTAssertEqual(payload["type"] as? String, "blocked")
        XCTAssertEqual(payload["reason"] as? String, "screen-recording")
        XCTAssertEqual(payload["hostSessionID"] as? String, "42")
        XCTAssertNil(payload["contextID"])
        XCTAssertNil(payload["width"])
    }

    /// Only ScreenCaptureKit's TCC refusal should suppress later attempts; a
    /// timeout or a missing window must stay retryable.
    func testOnlyUserDeclinedCountsAsAScreenRecordingDenial() {
        let declined = NSError(
            domain: "com.apple.ScreenCaptureKit.SCStreamErrorDomain",
            code: SCStreamError.Code.userDeclined.rawValue
        )
        let missingWindow = NSError(
            domain: "com.apple.ScreenCaptureKit.SCStreamErrorDomain",
            code: SCStreamError.Code.noWindowList.rawValue
        )

        XCTAssertTrue(ScreenRecordingAccess.isUserDeclined(declined))
        XCTAssertFalse(ScreenRecordingAccess.isUserDeclined(missingWindow))
    }

    func testComputerUseLaunchConfigurationDoesNotActivateTargetApp() {
        XCTAssertFalse(backgroundOpenConfiguration().activates)
    }

    func testFocusGuardOnlyRestoresAnUnintendedTargetActivation() {
        XCTAssertTrue(
            shouldRestoreForeground(
                previousPID: 42,
                targetBundleIdentifier: "target.app",
                currentFrontmostBundleIdentifier: "target.app",
                userIntervened: false
            )
        )
        XCTAssertFalse(
            shouldRestoreForeground(
                previousPID: 42,
                targetBundleIdentifier: "target.app",
                currentFrontmostBundleIdentifier: "target.app",
                userIntervened: true
            )
        )
        XCTAssertFalse(
            shouldRestoreForeground(
                previousPID: 42,
                targetBundleIdentifier: "target.app",
                currentFrontmostBundleIdentifier: "another.app",
                userIntervened: false
            )
        )
    }
}
