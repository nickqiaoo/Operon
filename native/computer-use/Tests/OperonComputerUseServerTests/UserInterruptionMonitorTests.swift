import AppKit
import XCTest
@testable import OperonComputerUseServer

final class UserInterruptionMonitorTests: XCTestCase {
    private let targetApp = "unknown.fixture.app"
    private let firstTurn: [String: Any] = [
        "session_id": "conversation",
        "turn_id": "turn-1",
    ]

    override func setUp() {
        super.setUp()
        UserInterruptionMonitor.shared.resetForTesting()
        UserInterruptionMonitor.shared.setScreenLockedForTesting(false)
    }

    override func tearDown() {
        UserInterruptionMonitor.shared.resetForTesting()
        super.tearDown()
    }

    func testInputInAnotherAppDoesNotInterruptComputerUse() throws {
        let now = Date(timeIntervalSince1970: 1_000)
        try UserInterruptionMonitor.shared.beginRequest(
            app: targetApp,
            metadata: firstTurn,
            kind: .readState,
            now: now
        )

        UserInterruptionMonitor.shared.recordInteractionForTesting(
            bundleIdentifier: "another.app",
            at: now
        )

        XCTAssertNoThrow(
            try UserInterruptionMonitor.shared.beginRequest(
                app: targetApp,
                metadata: firstTurn,
                kind: .performAction,
                now: now
            )
        )
    }

    func testTargetInteractionRequiresFreshStateBeforeMoreActions() throws {
        let now = Date(timeIntervalSince1970: 1_000)
        try UserInterruptionMonitor.shared.beginRequest(
            app: targetApp,
            metadata: firstTurn,
            kind: .readState,
            now: now
        )
        UserInterruptionMonitor.shared.recordInteractionForTesting(
            bundleIdentifier: targetApp,
            at: now
        )

        assertSessionError(
            code: -10016,
            containing: "still interacting"
        ) {
            try UserInterruptionMonitor.shared.beginRequest(
                app: targetApp,
                metadata: firstTurn,
                kind: .performAction,
                now: now.addingTimeInterval(0.5)
            )
        }

        assertSessionError(
            code: -10016,
            containing: "Re-query the latest state"
        ) {
            try UserInterruptionMonitor.shared.beginRequest(
                app: targetApp,
                metadata: firstTurn,
                kind: .performAction,
                now: now.addingTimeInterval(2)
            )
        }

        XCTAssertNoThrow(
            try UserInterruptionMonitor.shared.beginRequest(
                app: targetApp,
                metadata: firstTurn,
                kind: .readState,
                now: now.addingTimeInterval(2)
            )
        )
        XCTAssertNoThrow(
            try UserInterruptionMonitor.shared.beginRequest(
                app: targetApp,
                metadata: firstTurn,
                kind: .performAction,
                now: now.addingTimeInterval(2)
            )
        )
    }

    func testExplicitStopAffectsOnlyTheCurrentTurn() throws {
        let nextTurn: [String: Any] = [
            "session_id": "conversation",
            "turn_id": "turn-2",
        ]
        try UserInterruptionMonitor.shared.beginRequest(
            app: targetApp,
            metadata: firstTurn,
            kind: .readState
        )
        UserInterruptionMonitor.shared.stopActiveTurn()

        assertSessionError(
            code: -10012,
            containing: "explicitly stopped by the user"
        ) {
            try UserInterruptionMonitor.shared.beginRequest(
                app: targetApp,
                metadata: firstTurn,
                kind: .readState
            )
        }
        XCTAssertNoThrow(
            try UserInterruptionMonitor.shared.beginRequest(
                app: targetApp,
                metadata: nextTurn,
                kind: .readState
            )
        )
    }

    func testHostSessionEndClearsStoppedStateAndActivePresentationScope() throws {
        let hostTurn: [String: Any] = [
            "session_id": "conversation",
            "turn_id": "turn-1",
            "operon_session_id": "chat-42",
        ]
        let scope = try XCTUnwrap(ComputerUseTurnScope(metadata: hostTurn))
        XCTAssertEqual(scope.hostSessionID, "chat-42")

        try UserInterruptionMonitor.shared.beginRequest(
            app: targetApp,
            metadata: hostTurn,
            kind: .readState
        )
        UserInterruptionMonitor.shared.stopActiveTurn()
        UserInterruptionMonitor.shared.endHostSession("chat-42")

        XCTAssertNoThrow(
            try UserInterruptionMonitor.shared.beginRequest(
                app: targetApp,
                metadata: hostTurn,
                kind: .readState
            )
        )
    }

    func testMissingTurnMetadataDoesNotCreatePersistentIntervention() {
        XCTAssertNoThrow(
            try UserInterruptionMonitor.shared.beginRequest(
                app: targetApp,
                metadata: nil,
                kind: .readState
            )
        )
        UserInterruptionMonitor.shared.recordInteractionForTesting(
            bundleIdentifier: targetApp,
            at: Date()
        )
        XCTAssertNoThrow(
            try UserInterruptionMonitor.shared.beginRequest(
                app: targetApp,
                metadata: nil,
                kind: .performAction
            )
        )
    }

    func testKeyboardInputOnlyTargetsTheControlledFrontmostApp() {
        XCTAssertTrue(
            eventTargetsControlledApplication(
                eventType: .keyDown,
                controlledPID: 42,
                frontmostPID: 42,
                pointerWindowPID: nil
            )
        )
        XCTAssertFalse(
            eventTargetsControlledApplication(
                eventType: .keyDown,
                controlledPID: 42,
                frontmostPID: 7,
                pointerWindowPID: nil
            )
        )
    }

    func testPointerInputOnlyTargetsTheControlledWindow() {
        XCTAssertTrue(
            eventTargetsControlledApplication(
                eventType: .leftMouseDown,
                controlledPID: 42,
                frontmostPID: 7,
                pointerWindowPID: 42
            )
        )
        XCTAssertFalse(
            eventTargetsControlledApplication(
                eventType: .leftMouseDown,
                controlledPID: 42,
                frontmostPID: 42,
                pointerWindowPID: 7
            )
        )
        XCTAssertFalse(
            eventTargetsControlledApplication(
                eventType: .mouseMoved,
                controlledPID: 42,
                frontmostPID: 42,
                pointerWindowPID: 42
            )
        )
    }

    func testJSONRPCErrorDescriptorPreservesCodexSessionCodes() {
        XCTAssertEqual(
            jsonRPCErrorDescriptor(for: ComputerUseSessionError.stoppedByUser).code,
            -10012
        )
        XCTAssertEqual(
            jsonRPCErrorDescriptor(for: ComputerUseSessionError.userIntervened("changed")).code,
            -10016
        )
        XCTAssertEqual(
            jsonRPCErrorDescriptor(for: ComputerUseSessionError.screenLocked).code,
            -10020
        )
    }

    func testLockedScreenRejectsComputerUse() {
        UserInterruptionMonitor.shared.setScreenLockedForTesting(true)

        assertSessionError(
            code: -10020,
            containing: "unavailable while the Mac is locked"
        ) {
            try UserInterruptionMonitor.shared.beginRequest(
                app: targetApp,
                metadata: firstTurn,
                kind: .readState
            )
        }
    }

    private func assertSessionError(
        code: Int,
        containing expectedText: String,
        operation: () throws -> Void
    ) {
        XCTAssertThrowsError(try operation()) { error in
            guard let coded = error as? ComputerUseJSONRPCError else {
                return XCTFail("Expected ComputerUseJSONRPCError, got \(error)")
            }
            XCTAssertEqual(coded.jsonRPCCode, code)
            XCTAssertTrue(coded.message.contains(expectedText), coded.message)
        }
    }
}
