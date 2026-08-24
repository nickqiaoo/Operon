import Foundation

/// **Mouse buttons are numbers, not strings.** (Corrected 2026-07-17 against frames recorded off
/// real sky; see SkyOracleTests.)
///
/// sky's `y2()` **normalises to Int** — `left|l → 0`, `right|r → 1`, `middle|m → 2` — before
/// anything goes over the wire. Verbatim:
/// ```js
/// case "l": case "left":   return 0;
/// case "r": case "right":  return 1;
/// case "m": case "middle": return 2;
/// ```
/// This was once written as a `String` raw enum (`"left"`), which made **every click fail to
/// decode at the wire level**.
/// A RawRepresentable enum's synthesised Codable encodes and decodes the rawValue directly, so an
/// Int raw type lines up exactly with `0`/`1`/`2`.
public enum MouseButton: Int, Codable, Equatable, Sendable {
    case left = 0
    case right = 1
    case middle = 2

    /// Downstream, OpenComputerUseKit's `mouse_button` is a string enum, so convert back to the
    /// whole word.
    public var name: String {
        switch self {
        case .left: return "left"
        case .right: return "right"
        case .middle: return "middle"
        }
    }
}

/// Scroll direction **is** a string: sky's `x()` normalises to the whole words
/// `"up"|"down"|"left"|"right"` before sending. (Asymmetric with mouseButton — do not assume
/// otherwise; this was confirmed against frames recorded off real sky.)
public enum Direction: String, Codable, Equatable, Sendable {
    case up, down, left, right
}

/// The target of an action: either an element index or a coordinate.
///
/// **elementID carries a String, not an Int.** sky's `h2()` reads `return String(e11)`, so what
/// actually goes over the wire is `{"elementID":{"_0":"5"}}` — a quoted 5.
/// Synthesised Codable gives →
///   .elementID("5")    => {"elementID":{"_0":"5"}}
///   .coordinate([x,y]) => {"coordinate":{"_0":[x,y]}}
public enum Target: Codable, Equatable, Sendable {
    case elementID(String)
    case coordinate([Double])
}

/// The action union for PerformAction.
/// The key point: Swift's synthesised enum Codable produces byte-for-byte what codex expects —
///   a labelled associated value uses the label as the key; an unlabelled single value becomes `_0`.
///   pressKey/type => {"pressKey":{"_0":...}} / {"type":{"_0":...}}
///   click => {"click":{"at":…,"clickCount":…,"mouseButton":…}}
///
/// ⚠️ **Every elementID is a String** (sky's `h2()` = `String(e11)`). These cases were once all
/// written as `Int`, which made every element-index-based action fail to decode at the wire level.
/// `SkyOracleTests` guards that with payloads recorded off real sky.
public enum Action: Codable, Equatable, Sendable {
    case click(at: Target, clickCount: Int, mouseButton: MouseButton)
    case drag(from: [Double], to: [Double])
    case scroll(at: Target, direction: Direction, pages: Int)
    case setValue(elementID: String, value: String)
    case performSecondaryAction(action: String, elementID: String)
    case selectText(elementID: String, text: String, prefix: String?, suffix: String?, selection: String)
    case pressKey(String)
    case type(String)
}

/// The request body of ComputerUseIPCAppPerformActionRequest: {app, action}
public struct PerformActionRequest: Codable, Equatable, Sendable {
    public var app: String
    public var action: Action
    public init(app: String, action: Action) {
        self.app = app
        self.action = action
    }
}
