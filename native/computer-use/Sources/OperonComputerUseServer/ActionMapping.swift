import Foundation
import OperonComputerUseWire

/// Maps codex's `Action` / requestType onto the flat `(name, [String:Any])` that the open engine's
/// `ComputerUseToolDispatcher.callTool(name:arguments:)` takes. Pure functions, unit-testable.
public enum ActionMapping {

    /// A codex Action from PerformAction → a dispatcher call.
    public static func dispatcherCall(app: String, action: Action) throws -> (name: String, arguments: [String: Any]) {
        switch action {
        case let .click(at, clickCount, mouseButton):
            var args: [String: Any] = [
                "app": app,
                "click_count": clickCount,
                // Int (0/1/2) on the wire, but the dispatcher's mouse_button is a string enum,
                // so convert to the whole word.
                "mouse_button": mouseButton.name,
            ]
            apply(target: at, into: &args)
            return ("click", args)

        case let .drag(from, to):
            let (fx, fy) = try point(from, "drag.from")
            let (tx, ty) = try point(to, "drag.to")
            return ("drag", [
                "app": app, "from_x": fx, "from_y": fy, "to_x": tx, "to_y": ty,
            ])

        case let .scroll(at, direction, pages):
            var args: [String: Any] = [
                "app": app,
                "direction": direction.rawValue,
                "pages": pages,
            ]
            apply(target: at, into: &args)
            return ("scroll", args)

        case let .setValue(elementID, value):
            return ("set_value", ["app": app, "element_index": elementID, "value": value])

        case let .performSecondaryAction(actionName, elementID):
            return ("perform_secondary_action", [
                "app": app, "element_index": elementID, "action": actionName,
            ])

        case let .selectText(elementID, text, prefix, suffix, selection):
            var args: [String: Any] = ["app": app, "element_index": elementID, "text": text, "selection": selection]
            if let prefix { args["prefix"] = prefix }
            if let suffix { args["suffix"] = suffix }
            return ("select_text", args)

        case let .pressKey(key):
            return ("press_key", ["app": app, "key": key])

        case let .type(text):
            return ("type_text", ["app": app, "text": text])
        }
    }

    // MARK: - helpers

    /// elementID is a String and is passed **straight through** to the dispatcher: its
    /// `element_index` is declared as a stringProperty already
    /// (`normalizedElementIndexArgument` accepts String or Int), so no conversion is needed.
    private static func apply(target: Target, into args: inout [String: Any]) {
        switch target {
        case let .elementID(n):
            args["element_index"] = n
        case let .coordinate(xy):
            if xy.count == 2 {
                args["x"] = xy[0]
                args["y"] = xy[1]
            }
        }
    }

    private static func point(_ xy: [Double], _ label: String) throws -> (Double, Double) {
        guard xy.count == 2 else { throw MappingError.invalid("\(label) requires [x, y]") }
        return (xy[0], xy[1])
    }
}

public enum MappingError: Swift.Error, Equatable {
    case unsupported(String)
    case invalid(String)
}
