import AppKit
import CoreGraphics
import Foundation

/// The CPS process-notification event type, and the focus subtypes used to
/// **construct** synthetic notifications that get posted to a target process.
///
/// Direction matters here and getting it backwards cost a full round of wrong
/// experiments. These subtypes are *outbound*: the official
/// `SynthesizedEvent.notifyAppActivated` / `notifyWindowKeyFocusReturned` /
/// `notifyWindowKeyFocusRemoved` builders stamp them onto events that are then
/// `postToPid`-ed straight into the target. They are not a filter applied to
/// events arriving through an event tap — which is why live capture never sees
/// them, and why suppressing tapped notifications does nothing (measured: an
/// active tap swallowing all 15 notifications did not stop the foreground from
/// moving).
///
/// `Observation` covers the separate, inbound question of what a tapped event
/// on this type actually contains. Its `subjectPID` is confirmed; its
/// `subtypeCandidate` is reported raw and deliberately not matched against the
/// table above, because the two are not the same namespace.
public enum CPSNotification {
    /// `kCGSEventNotify`. Not a documented `CGEventType`; the official tap
    /// registers exactly `1 << 21` and nothing else.
    public static let eventTypeRawValue: UInt32 = 21

    public static let eventTypeMask: UInt64 = 1 << UInt64(eventTypeRawValue)

    /// Focus subtypes, with the values the official binary compiles in.
    ///
    /// Used when *building* a synthetic notification for a target process. The
    /// small values are bit-shaped and the `0xF1xx` values are discrete, which
    /// suggests two families sharing one event type; they are recorded verbatim
    /// rather than normalised.
    public enum Subtype: Int32, CaseIterable, Sendable {
        case newFront = 0x1000
        case lostKeyFocus = 0x4000
        case keyFocusTaken = 0x8000
        case keyFocusReturned = 0xF102
        case keyFocusChanged = 0xF105
        /// Official `kCPSNotifyLostTypingFocus` (lazy init writes `0xF107`).
        /// `kCPSNotifyTypingFocusChanged` shares the same storage value in this
        /// build.
        case lostTypingFocus = 0xF107
    }

    public static func isKnownFocusSubtype(_ value: Int32) -> Bool {
        Subtype(rawValue: value) != nil
    }

    /// `CGEventField` indices for CPS process-notification events.
    ///
    /// Values established by observing the reference implementation's lazily
    /// initialised field table:
    ///   51, 55, 64, **69**, **71**, 73, 66, 67
    /// Getters map: `focusThiefAlsoStoleTypingFocus` → **69** (`#0x3d0`),
    /// `focusTheftID` → **71** (`#0x3d8`), `subjectPID` → **73** (`#0x3e0`).
    public enum ObservedField {
        /// Reads back as 21 — i.e. the event type itself.
        public static let eventType: UInt32 = 55
        /// Inbound subtype candidate (different namespace from `Subtype`).
        public static let subtypeCandidate: UInt32 = 64
        /// Official `CGEventRef.focusThiefAlsoStoleTypingFocus` (Bool-ish).
        public static let focusThiefAlsoStoleTypingFocus: UInt32 = 69
        /// Official `CGEventRef.focusTheftID` (UInt32?).
        public static let focusTheftID: UInt32 = 71
        /// Serial number of the application this notification is about.
        public static let subjectSerialNumber: UInt32 = 67
        /// Pid of that same application (thief / subject).
        public static let subjectPID: UInt32 = 73
    }

    /// What a tapped event was measured to contain. Deliberately not called a
    /// "decode": nothing here is interpreted beyond reading fields.
    public struct Observation: Equatable, Sendable {
        public var eventType: UInt32
        public var subtypeCandidate: Int64
        /// Serial number of the application this notification is about.
        public var subjectSerialNumber: UInt32?
        /// pid of that same application. This is the field a suppressor keys
        /// on: the official type is called `DisallowedThiefProcess` and holds
        /// a pid, and this is the pid of the process taking focus.
        public var subjectPID: pid_t?
        public var sourcePID: pid_t?
        /// Official `focusThiefAlsoStoleTypingFocus` (field 69): non-zero → true.
        public var focusThiefAlsoStoleTypingFocus: Bool?

        /// Always nil in practice: inbound events do not carry the outbound
        /// `Subtype` namespace. Kept so the distinction stays visible in code
        /// rather than living only in a comment.
        public var matchedSubtype: Subtype? {
            guard let value = Int32(exactly: subtypeCandidate) else {
                return nil
            }
            return Subtype(rawValue: value)
        }

        public init(
            eventType: UInt32,
            subtypeCandidate: Int64,
            subjectSerialNumber: UInt32?,
            subjectPID: pid_t?,
            sourcePID: pid_t?,
            focusThiefAlsoStoleTypingFocus: Bool? = nil
        ) {
            self.eventType = eventType
            self.subtypeCandidate = subtypeCandidate
            self.subjectSerialNumber = subjectSerialNumber
            self.subjectPID = subjectPID
            self.sourcePID = sourcePID
            self.focusThiefAlsoStoleTypingFocus = focusThiefAlsoStoleTypingFocus
        }
    }

    /// Reads the fields of a tapped event, or returns nil when it is not a CPS
    /// notification.
    public static func observe(_ event: CGEvent) -> Observation? {
        guard event.type.rawValue == eventTypeRawValue else {
            return nil
        }
        let sourcePID = pid_t(event.getIntegerValueField(.eventSourceUnixProcessID))
        let subjectPID = pid_t(integerField(event, ObservedField.subjectPID))
        let serialNumber = UInt32(
            exactly: integerField(event, ObservedField.subjectSerialNumber)
        )
        // Official getter: `cset ne` — non-zero → true.
        let stoleTyping = integerField(event, ObservedField.focusThiefAlsoStoleTypingFocus) != 0
        return Observation(
            eventType: event.type.rawValue,
            subtypeCandidate: integerField(event, ObservedField.subtypeCandidate),
            subjectSerialNumber: serialNumber,
            subjectPID: subjectPID <= 0 ? nil : subjectPID,
            sourcePID: sourcePID == 0 ? nil : sourcePID,
            focusThiefAlsoStoleTypingFocus: stoleTyping
        )
    }

    /// Official `CGEventRef.focusThiefAlsoStoleTypingFocus` (field **69**).
    public static func focusThiefAlsoStoleTypingFocus(_ event: CGEvent) -> Bool? {
        guard event.type.rawValue == eventTypeRawValue else {
            return nil
        }
        return integerField(event, ObservedField.focusThiefAlsoStoleTypingFocus) != 0
    }

    private static func integerField(_ event: CGEvent, _ raw: UInt32) -> Int64 {
        guard let field = CGEventField(rawValue: raw) else {
            return 0
        }
        return event.getIntegerValueField(field)
    }
}
