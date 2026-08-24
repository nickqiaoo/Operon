import XCTest
@testable import OperonSystemSoftware

/// The constant tables are the part of this layer that was recovered from the
/// official binary rather than designed, so they are pinned literally. If one
/// of these ever needs changing, it must be because the binary was re-read —
/// not because something downstream was easier to write that way.
final class SetFrontProcessOptionsTests: XCTestCase {
    func testRawValuesMatchTheOfficialBinary() {
        XCTAssertEqual(SetFrontProcessOptions.allWindows.rawValue, 0x100)
        XCTAssertEqual(SetFrontProcessOptions.causedByUser.rawValue, 0x200)
        XCTAssertEqual(SetFrontProcessOptions.noWindows.rawValue, 0x400)
        XCTAssertEqual(SetFrontProcessOptions.dontUnhide.rawValue, 0x800)
    }

    func testWithoutRaisingWindowsLeavesWindowOrderingAlone() {
        let options = SetFrontProcessOptions.withoutRaisingWindows

        XCTAssertTrue(options.contains(.noWindows))
        XCTAssertTrue(options.contains(.causedByUser))
        XCTAssertFalse(
            options.contains(.allWindows),
            "allWindows would raise the target's windows, which is the exact behaviour being removed"
        )
        XCTAssertEqual(options.rawValue, 0x600)
    }
}

final class CPSNotificationTests: XCTestCase {
    func testEventTypeIsTwentyOne() {
        XCTAssertEqual(CPSNotification.eventTypeRawValue, 21)
        XCTAssertEqual(CPSNotification.eventTypeMask, 0x200000)
    }

    func testSubtypeTableMatchesTheOfficialBinary() {
        XCTAssertEqual(CPSNotification.Subtype.newFront.rawValue, 0x1000)
        XCTAssertEqual(CPSNotification.Subtype.lostKeyFocus.rawValue, 0x4000)
        XCTAssertEqual(CPSNotification.Subtype.keyFocusTaken.rawValue, 0x8000)
        XCTAssertEqual(CPSNotification.Subtype.keyFocusReturned.rawValue, 0xF102)
        XCTAssertEqual(CPSNotification.Subtype.keyFocusChanged.rawValue, 0xF105)
        XCTAssertEqual(CPSNotification.Subtype.lostTypingFocus.rawValue, 0xF107)
    }

    // Guards the specific mistake the previous implementation made: it named
    // 0x8000 "KeyFocusReturned" when the official binary calls that value
    // KeyFocusTaken, and gives KeyFocusReturned a completely different value.
    func testKeyFocusTakenAndReturnedAreNotTheSameValue() {
        XCTAssertNotEqual(
            CPSNotification.Subtype.keyFocusTaken.rawValue,
            CPSNotification.Subtype.keyFocusReturned.rawValue
        )
        XCTAssertEqual(CPSNotification.Subtype(rawValue: 0x8000), .keyFocusTaken)
    }

    func testUnknownSubtypesAreNotClaimedAsFocusEvents() {
        // 2 is what live capture reports on inbound events of this type. The
        // Subtype table is an outbound construction namespace, so a match here
        // would be a category error, not a discovery.
        XCTAssertFalse(CPSNotification.isKnownFocusSubtype(2))
        XCTAssertFalse(CPSNotification.isKnownFocusSubtype(0))
        XCTAssertTrue(CPSNotification.isKnownFocusSubtype(0x1000))
    }

    func testObservationReportsTheSubjectProcessAndNoSubtype() {
        let observation = CPSNotification.Observation(
            eventType: 21,
            subtypeCandidate: 2,
            subjectSerialNumber: 0x1F01F,
            subjectPID: 1219,
            sourcePID: nil
        )

        // subjectPID is the field a suppressor would key on, and it is the one
        // part of an inbound notification that live capture confirmed.
        XCTAssertEqual(observation.subjectPID, 1219)
        XCTAssertEqual(observation.subjectSerialNumber, 0x1F01F)
        XCTAssertNil(
            observation.matchedSubtype,
            "inbound events do not carry the outbound Subtype namespace"
        )
    }
}

final class DynamicSymbolTests: XCTestCase {
    func testResolvesAKnownSystemSymbol() {
        XCTAssertNotNil(DynamicSymbol.lookup("CGSMainConnectionID"))
    }

    func testMissingSymbolDegradesToNilRatherThanTrapping() {
        XCTAssertNil(DynamicSymbol.lookup("OperonDefinitelyNotARealSymbol"))
        XCTAssertNil(
            DynamicSymbol.lookupAny([
                "OperonDefinitelyNotARealSymbol",
                "OperonAlsoNotReal",
            ])
        )
    }

    func testLookupAnyPrefersTheFirstSpellingThatResolves() {
        let resolved = DynamicSymbol.lookupAny([
            "OperonDefinitelyNotARealSymbol",
            "CGSMainConnectionID",
        ])

        XCTAssertNotNil(resolved)
        XCTAssertEqual(resolved, DynamicSymbol.lookup("CGSMainConnectionID"))
    }
}

/// These touch the real system, but only through read-only calls, and each one
/// asserts the degradation contract rather than a particular machine's state.
final class ApplicationRegistrySPILiveTests: XCTestCase {
    func testSerialNumberIsNilForAProcessThatCannotExist() {
        XCTAssertNil(ApplicationRegistrySPI.serialNumber(for: -1))
    }

    func testAvailabilityNeverClaimsMoreThanItVerified() {
        ApplicationRegistrySPI.establishWindowServerConnection()
        let availability = ApplicationRegistrySPI.probeAvailability()

        if !availability.canResolveSerialNumbers {
            XCTAssertFalse(
                availability.isFullyAvailable,
                "pid resolution is a prerequisite; nothing may report available without it"
            )
            XCTAssertFalse(availability.notes.isEmpty, "a degraded result must explain itself")
        }
    }
}
