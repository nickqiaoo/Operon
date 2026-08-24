import Foundation

/// Runtime resolution of private system symbols.
///
/// The background-focus work depends on CoreGraphics/SkyLight SPI that ships no
/// header and carries no compatibility promise. Resolving by name at runtime
/// turns a renamed or withdrawn symbol into a degraded feature instead of a
/// link-time failure, which is what lets callers fall back instead of crashing.
public enum DynamicSymbol {
    /// SkyLight owns the implementations; CoreGraphics re-exports them under the
    /// historical `CPS` prefix. Both are searched so either spelling resolves.
    private static let searchPaths = [
        "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics",
        "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",
    ]

    // Written once during lazy init and only ever read afterwards.
    nonisolated(unsafe) private static let handles: [UnsafeMutableRawPointer] = searchPaths.compactMap {
        dlopen($0, RTLD_LAZY)
    }

    nonisolated(unsafe) private static let globalHandle = UnsafeMutableRawPointer(bitPattern: -2)

    public static func lookup(_ name: String) -> UnsafeMutableRawPointer? {
        for handle in handles {
            if let symbol = dlsym(handle, name) {
                return symbol
            }
        }
        return dlsym(globalHandle, name)
    }

    /// Resolves the first available spelling, so callers can list both the
    /// `_SLPS…` and `_CPS…` names of the same routine.
    public static func lookupAny(_ names: [String]) -> UnsafeMutableRawPointer? {
        for name in names {
            if let symbol = lookup(name) {
                return symbol
            }
        }
        return nil
    }

    public static func function<T>(_ names: [String], as type: T.Type) -> T? {
        guard let symbol = lookupAny(names) else {
            return nil
        }
        return unsafeBitCast(symbol, to: type)
    }
}
