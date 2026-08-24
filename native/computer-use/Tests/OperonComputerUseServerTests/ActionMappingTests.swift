import XCTest
import OperonComputerUseWire
@testable import OperonComputerUseServer

/// Pure mapping tests from a codex Action to the open dispatcher's flat args (no AX involved).
final class ActionMappingTests: XCTestCase {

    private func call(_ action: Action, app: String = "TextEdit") throws -> (String, [String: Any]) {
        try ActionMapping.dispatcherCall(app: app, action: action)
    }

    func testClickElement() throws {
        let (name, args) = try call(.click(at: .elementID("5"), clickCount: 1, mouseButton: .left))
        XCTAssertEqual(name, "click")
        XCTAssertEqual(args["app"] as? String, "TextEdit")
        XCTAssertEqual(args["element_index"] as? String, "5")  // a String on the wire, passed straight through
        XCTAssertEqual(args["click_count"] as? Int, 1)
        XCTAssertEqual(args["mouse_button"] as? String, "left")
        XCTAssertNil(args["x"])
    }

    func testClickCoordinate() throws {
        let (name, args) = try call(.click(at: .coordinate([12, 34]), clickCount: 2, mouseButton: .right))
        XCTAssertEqual(name, "click")
        XCTAssertEqual(args["x"] as? Double, 12)
        XCTAssertEqual(args["y"] as? Double, 34)
        XCTAssertEqual(args["click_count"] as? Int, 2)
        XCTAssertEqual(args["mouse_button"] as? String, "right")
        XCTAssertNil(args["element_index"])
    }

    func testDrag() throws {
        let (name, args) = try call(.drag(from: [1, 2], to: [3, 4]))
        XCTAssertEqual(name, "drag")
        XCTAssertEqual(args["from_x"] as? Double, 1)
        XCTAssertEqual(args["from_y"] as? Double, 2)
        XCTAssertEqual(args["to_x"] as? Double, 3)
        XCTAssertEqual(args["to_y"] as? Double, 4)
    }

    func testScroll() throws {
        let (name, args) = try call(.scroll(at: .elementID("7"), direction: .down, pages: 1))
        XCTAssertEqual(name, "scroll")
        XCTAssertEqual(args["element_index"] as? String, "7")
        XCTAssertEqual(args["direction"] as? String, "down")
        XCTAssertEqual(args["pages"] as? Int, 1)
    }

    func testSetValue() throws {
        let (name, args) = try call(.setValue(elementID: "9", value: "hi"))
        XCTAssertEqual(name, "set_value")
        XCTAssertEqual(args["element_index"] as? String, "9")
        XCTAssertEqual(args["value"] as? String, "hi")
    }

    func testPerformSecondary() throws {
        let (name, args) = try call(.performSecondaryAction(action: "Raise", elementID: "3"))
        XCTAssertEqual(name, "perform_secondary_action")
        XCTAssertEqual(args["element_index"] as? String, "3")
        XCTAssertEqual(args["action"] as? String, "Raise")
    }

    func testPressKey() throws {
        let (name, args) = try call(.pressKey("Return"))
        XCTAssertEqual(name, "press_key")
        XCTAssertEqual(args["key"] as? String, "Return")
    }

    func testTypeText() throws {
        let (name, args) = try call(.type("hello"))
        XCTAssertEqual(name, "type_text")
        XCTAssertEqual(args["text"] as? String, "hello")
    }

    func testSelectText() throws {
        let (name, args) = try call(.selectText(elementID: "4", text: "hi", prefix: "a", suffix: "b", selection: "text"))
        XCTAssertEqual(name, "select_text")
        XCTAssertEqual(args["element_index"] as? String, "4")
        XCTAssertEqual(args["text"] as? String, "hi")
        XCTAssertEqual(args["prefix"] as? String, "a")
        XCTAssertEqual(args["suffix"] as? String, "b")
        XCTAssertEqual(args["selection"] as? String, "text")
    }

    func testSelectTextOmitsNilPrefixSuffix() throws {
        let (_, args) = try call(.selectText(elementID: "1", text: "x", prefix: nil, suffix: nil, selection: "cursor_before"))
        XCTAssertNil(args["prefix"])
        XCTAssertNil(args["suffix"])
        XCTAssertEqual(args["selection"] as? String, "cursor_before")
    }
}
