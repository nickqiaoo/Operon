import CoreGraphics
import Foundation

/// Thin wrappers around private WindowServer helpers used by Codex
/// `SystemSoftware.WindowServerSPI` when building process-local mouse events.
///
/// Official `SynthesizedEvent.mouseEvent` / `notifyAppActivated` call
/// `setWindowLocation(_:location:)` after packing CGEvent fields. The symbol
/// is resolved lazily at runtime; we probe a small name list and no-op when
/// unavailable (fields 0x5b/0x5c still provide window targeting).
public enum WindowServerEventSPI {
    private typealias SetWindowLocationFn = @convention(c) (
        CGEvent?,
        CGFloat,
        CGFloat
    ) -> Void

    private typealias SetWindowLocationPointFn = @convention(c) (
        CGEvent?,
        CGPoint
    ) -> Void

    private static let setWindowLocationPoint: SetWindowLocationPointFn? = {
        let names = [
            "CGSEventSetWindowLocation",
            "_CGSEventSetWindowLocation",
            "CGEventSetWindowLocation",
        ]
        for name in names {
            if let fn: SetWindowLocationPointFn = DynamicSymbol.function([name], as: SetWindowLocationPointFn.self) {
                return fn
            }
        }
        return nil
    }()

    private static let setWindowLocationXY: SetWindowLocationFn? = {
        let names = [
            "CGSEventSetWindowLocation",
            "_CGSEventSetWindowLocation",
        ]
        for name in names {
            if let fn: SetWindowLocationFn = DynamicSymbol.function([name], as: SetWindowLocationFn.self) {
                return fn
            }
        }
        return nil
    }()

    /// Mirrors Codex `WindowServerSPI.setWindowLocation(_:location:)`.
    public static func setWindowLocation(_ event: CGEvent, location: CGPoint) {
        if let setWindowLocationPoint {
            setWindowLocationPoint(event, location)
            return
        }
        if let setWindowLocationXY {
            setWindowLocationXY(event, location.x, location.y)
        }
    }
}
