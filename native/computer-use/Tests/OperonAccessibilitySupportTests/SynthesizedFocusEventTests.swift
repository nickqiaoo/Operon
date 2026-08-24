import AppKit
import CoreGraphics
import XCTest
@testable import OperonAccessibilitySupport
@testable import OperonSystemSoftware

/// These pin the event shapes recovered from the official binary. Every value
/// here came from observing the reference implementation, so a failure means either the
/// reconstruction drifted or the binary was re-read — never that the test
/// should be relaxed.
final class SynthesizedFocusEventTests: XCTestCase {
    func testAppActivatedUsesAppKitDefinedSubtypeOne() throws {
        let synthesized = try XCTUnwrap(SynthesizedFocusEvent.appActivated(windowID: 0))
        let event = try XCTUnwrap(NSEvent(cgEvent: synthesized.event))

        XCTAssertEqual(event.type, .appKitDefined)
        XCTAssertEqual(event.subtype.rawValue, 1)
    }

    func testAppDeactivatedUsesSubtypeTwo() throws {
        let synthesized = try XCTUnwrap(SynthesizedFocusEvent.appDeactivated())
        let event = try XCTUnwrap(NSEvent(cgEvent: synthesized.event))

        XCTAssertEqual(event.type, .appKitDefined)
        XCTAssertEqual(event.subtype.rawValue, 2)
    }

    // The official builder sets control|option (0xC0000) only when a window is
    // named. There is no way to arrive at that pair by reasoning, so it is
    // pinned exactly.
    func testActivationCarriesControlOptionOnlyWhenAWindowIsNamed() throws {
        let withWindow = try XCTUnwrap(SynthesizedFocusEvent.appActivated(windowID: 4242))
        let withoutWindow = try XCTUnwrap(SynthesizedFocusEvent.appActivated(windowID: 0))

        let withFlags = try XCTUnwrap(NSEvent(cgEvent: withWindow.event))
        let withoutFlags = try XCTUnwrap(NSEvent(cgEvent: withoutWindow.event))

        XCTAssertTrue(withFlags.modifierFlags.contains(.control))
        XCTAssertTrue(withFlags.modifierFlags.contains(.option))
        XCTAssertEqual(withFlags.windowNumber, 4242)

        XCTAssertFalse(withoutFlags.modifierFlags.contains(.control))
        XCTAssertFalse(withoutFlags.modifierFlags.contains(.option))
        XCTAssertEqual(withoutFlags.windowNumber, 0)
    }

    func testKeyFocusReturnedUsesKeyFocusReturnedSubtype() throws {
        let synthesized = try XCTUnwrap(SynthesizedFocusEvent.windowKeyFocusReturned())
        let event = try XCTUnwrap(NSEvent(cgEvent: synthesized.event))

        XCTAssertEqual(
            event.subtype.rawValue,
            Int16(bitPattern: 0xF102),
            "kCPSNotifyKeyFocusReturned"
        )
    }

    // The counter-intuitive one. "Removed" is expressed as "someone else took
    // it" — the official builder loads kCPSNotifyKeyFocusTaken (0x8000), not
    // kCPSNotifyLostKeyFocus (0x4000). Established by matching the global each
    // builder reads against the addressor of each subtype getter, so this is a
    // measurement, not a reading of the names.
    func testKeyFocusRemovedUsesKeyFocusTakenNotLostKeyFocus() throws {
        let synthesized = try XCTUnwrap(SynthesizedFocusEvent.windowKeyFocusRemoved())
        let event = try XCTUnwrap(NSEvent(cgEvent: synthesized.event))

        XCTAssertEqual(
            event.subtype.rawValue,
            Int16(bitPattern: 0x8000),
            "kCPSNotifyKeyFocusTaken"
        )
        XCTAssertNotEqual(
            event.subtype.rawValue,
            Int16(bitPattern: 0x4000),
            "kCPSNotifyLostKeyFocus would be the obvious guess and it is wrong"
        )
    }

    func testKeyFocusEventsUseTheProcessNotificationType() throws {
        let returned = try XCTUnwrap(SynthesizedFocusEvent.windowKeyFocusReturned())

        XCTAssertEqual(
            returned.event.type.rawValue,
            UInt32(SynthesizedFocusEvent.processNotificationTypeRawValue)
        )
        XCTAssertEqual(SynthesizedFocusEvent.processNotificationTypeRawValue, 21)
    }

    // Both subtypes exceed Int16.max as unsigned values; converting with
    // Int16(exactly:) would silently produce no event at all.
    func testOutOfRangeSubtypesSurviveTheConversionToNSEvent() {
        XCTAssertNotNil(SynthesizedFocusEvent.windowKeyFocusReturned())
        XCTAssertNotNil(SynthesizedFocusEvent.windowKeyFocusRemoved())
        XCTAssertNil(Int16(exactly: CPSNotification.Subtype.keyFocusTaken.rawValue))
        XCTAssertNil(Int16(exactly: CPSNotification.Subtype.keyFocusReturned.rawValue))
    }

    /// Official `notifyAppActivated` with bounds + nil activationPoint appends
    /// leftMouseDown and leftMouseUp, not mouseMoved.
    func testAppActivatedSequenceWithBoundsIncludesDownUp() {
        let bounds = CGRect(x: 100, y: 200, width: 400, height: 300)
        let sequence = SynthesizedFocusEvent.appActivatedSequence(
            windowID: 4242,
            windowBounds: bounds
        )
        XCTAssertEqual(sequence.count, 3, "activate + down + up")
        // CGEventType has no appKitDefined case — NSEvent maps type 13.
        XCTAssertEqual(
            try XCTUnwrap(NSEvent(cgEvent: sequence[0].event)).type,
            .appKitDefined
        )
        XCTAssertEqual(sequence[1].event.type, .leftMouseDown)
        XCTAssertEqual(sequence[2].event.type, .leftMouseUp)
        // mouseEventSubtype field 7 = 3 on arming clicks
        XCTAssertEqual(
            sequence[1].event.getIntegerValueField(.mouseEventSubtype),
            3
        )
        XCTAssertEqual(
            sequence[1].event.getIntegerValueField(.mouseEventWindowUnderMousePointer),
            4242
        )
    }

    func testAppActivatedSequenceWithoutBoundsIsActivateOnly() {
        let sequence = SynthesizedFocusEvent.appActivatedSequence(
            windowID: 1,
            windowBounds: nil
        )
        XCTAssertEqual(sequence.count, 1)
        XCTAssertEqual(
            try XCTUnwrap(NSEvent(cgEvent: sequence[0].event)).type,
            .appKitDefined
        )
    }
}
