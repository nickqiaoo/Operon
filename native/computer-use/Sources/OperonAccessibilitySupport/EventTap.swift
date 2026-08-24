import CoreGraphics
import Foundation

/// A CGEvent tap with the same knobs the official `AccessibilitySupport.EventTap`
/// exposes: event mask, location, placement, options and auto-reenable.
///
/// `options: .defaultTap` makes the tap *active*, meaning the callback may
/// return nil to swallow an event. The official process-notification tap is
/// created that way — that is how a focus transfer is hidden from the rest of
/// the system.
public final class EventTap {
    /// Where the tap is inserted. `pid` maps onto `CGEvent.tapCreateForPid`,
    /// which is how the official build scopes taps to one target process.
    ///
    /// The case order mirrors `CGEventTapLocation` because the official build
    /// stores `2` for its process-notification tap, which lines up with
    /// `annotatedSession`. That mapping is inferred, not confirmed.
    public enum Location: Equatable, Sendable {
        case hid
        case session
        case annotatedSession
        case pid(pid_t)
    }

    public let eventTypes: UInt64
    public let location: Location
    public let placement: CGEventTapPlacement
    public let options: CGEventTapOptions

    /// Re-enable the tap if the system disables it. macOS drops a tap whose
    /// callback is too slow (`tapDisabledByTimeout`), and a silently dead tap
    /// would look exactly like "focus stealing no longer happens".
    public var shouldAutoreenable = true

    private var machPort: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var handler: ((CGEventType, CGEvent) -> CGEvent?)?

    public init(
        eventTypes: UInt64,
        location: Location = .annotatedSession,
        placement: CGEventTapPlacement = .tailAppendEventTap,
        options: CGEventTapOptions = .defaultTap
    ) {
        self.eventTypes = eventTypes
        self.location = location
        self.placement = placement
        self.options = options
    }

    deinit {
        stopMonitoring()
    }

    public var isMonitoring: Bool {
        machPort != nil
    }

    public var isEnabled: Bool {
        machPort.map(CGEvent.tapIsEnabled) ?? false
    }

    /// Installs the tap on the current run loop.
    ///
    /// Returns false when the tap could not be created — normally a missing
    /// Accessibility or Input Monitoring grant. Callers must degrade rather
    /// than assume the tap is live.
    @discardableResult
    public func startMonitoring(
        _ handler: @escaping (CGEventType, CGEvent) -> CGEvent?
    ) -> Bool {
        stopMonitoring()
        self.handler = handler

        let context = Unmanaged.passUnretained(self).toOpaque()
        let callback: CGEventTapCallBack = { _, type, event, userInfo in
            guard let userInfo else {
                return Unmanaged.passUnretained(event)
            }
            let tap = Unmanaged<EventTap>.fromOpaque(userInfo).takeUnretainedValue()
            return tap.dispatch(type: type, event: event)
        }

        let created: CFMachPort?
        switch location {
        case let .pid(pid):
            created = CGEvent.tapCreateForPid(
                pid: pid,
                place: placement,
                options: options,
                eventsOfInterest: eventTypes,
                callback: callback,
                userInfo: context
            )
        case .hid, .session, .annotatedSession:
            created = CGEvent.tapCreate(
                tap: coreGraphicsLocation,
                place: placement,
                options: options,
                eventsOfInterest: eventTypes,
                callback: callback,
                userInfo: context
            )
        }

        guard let created else {
            self.handler = nil
            return false
        }

        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, created, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
        CGEvent.tapEnable(tap: created, enable: true)
        machPort = created
        runLoopSource = source
        return true
    }

    public func stopMonitoring() {
        if let machPort {
            CGEvent.tapEnable(tap: machPort, enable: false)
            CFMachPortInvalidate(machPort)
        }
        if let runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
        }
        machPort = nil
        runLoopSource = nil
        handler = nil
    }

    private var coreGraphicsLocation: CGEventTapLocation {
        switch location {
        case .hid:
            return .cghidEventTap
        case .session:
            return .cgSessionEventTap
        case .annotatedSession, .pid:
            return .cgAnnotatedSessionEventTap
        }
    }

    private func dispatch(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if shouldAutoreenable, let machPort {
                CGEvent.tapEnable(tap: machPort, enable: true)
            }
            return Unmanaged.passUnretained(event)
        }
        guard let handler else {
            return Unmanaged.passUnretained(event)
        }
        guard let result = handler(type, event) else {
            return nil
        }
        return Unmanaged.passUnretained(result)
    }
}
