import XCTest
import Foundation
@testable import OperonComputerUseWire

/// The core check: whether Swift's synthesised Codable is byte-equivalent to codex's wire JSON.
/// Comparison goes through JSONSerialization into NSObject so it is structural and does not
/// depend on key order.
///
/// ⚠️ **Corrected 2026-07-17**: the expected JSON here used to be **guessed by hand** and did not
/// match the shape sky actually ships. Swift encoding, the hand-written expectation and Swift
/// decoding then agreed with each other while all three were wrong — **every test green, the
/// product entirely broken**. Every expectation now comes from **payloads recorded off the real
/// vendored sky** (`SkyOracleTests` is the automated form of that recorder, re-recorded on each
/// CI run). Before changing an expectation here, record it there instead of writing it out.
///
/// What the guesses missed — each one enough to make the matching action fail to decode at the
/// wire level:
///   - `elementID` is a **String** (`"5"`), not an Int
///   - `mouseButton` is an **Int** (`0`/`1`/`2`), not `"left"`
final class WireTests: XCTestCase {

    private let encoder = JSONEncoder()

    private func obj(_ data: Data) throws -> NSObject {
        try JSONSerialization.jsonObject(with: data, options: []) as! NSObject
    }
    private func obj(_ s: String) throws -> NSObject {
        try obj(Data(s.utf8))
    }

    /// Asserts that value encodes to JSON structurally equal to the shape codex expects.
    private func assertShape<T: Encodable>(_ value: T, _ expected: String,
                                           _ message: String = "",
                                           file: StaticString = #filePath, line: UInt = #line) throws {
        let got = try obj(encoder.encode(value))
        let want = try obj(expected)
        XCTAssertTrue(got.isEqual(want),
                      "\(message)\n got:  \(got)\n want: \(want)",
                      file: file, line: line)
    }

    // MARK: - action union shape (byte-for-byte with codex)

    func testPressKeyShape() throws {
        try assertShape(Action.pressKey("Return"),
                        #"{"pressKey":{"_0":"Return"}}"#, "pressKey must be an unlabelled _0")
    }

    func testTypeShape() throws {
        try assertShape(Action.type("hello"),
                        #"{"type":{"_0":"hello"}}"#, "type must be an unlabelled _0")
    }

    /// Recorded off real sky: `sky.click({app, element_index: 5})`
    /// ⇒ elementID._0 is the string "5" (sky's `h2()` = `String(e11)`), and mouseButton is 0
    /// (`y2()` maps left→0).
    func testClickElementShape() throws {
        try assertShape(Action.click(at: .elementID("5"), clickCount: 1, mouseButton: .left),
                        #"{"click":{"at":{"elementID":{"_0":"5"}},"clickCount":1,"mouseButton":0}}"#)
    }

    /// Recorded off real sky: `sky.click({app, x: 12, y: 34, click_count: 2, mouse_button: "right"})`
    func testClickCoordinateShape() throws {
        try assertShape(Action.click(at: .coordinate([12, 34]), clickCount: 2, mouseButton: .right),
                        #"{"click":{"at":{"coordinate":{"_0":[12,34]}},"clickCount":2,"mouseButton":1}}"#)
    }

    /// Recorded off real sky: `sky.drag({app, from_x: 1, from_y: 2, to_x: 3, to_y: 4})`
    func testDragShape() throws {
        try assertShape(Action.drag(from: [1, 2], to: [3, 4]),
                        #"{"drag":{"from":[1,2],"to":[3,4]}}"#)
    }

    /// Recorded off real sky: `sky.scroll({app, element_index: 7, direction: "down"})`
    /// ⇒ direction **is** a whole-word string (normalised by `x()`), asymmetric with
    /// mouseButton's number.
    func testScrollShape() throws {
        try assertShape(Action.scroll(at: .elementID("7"), direction: .down, pages: 1),
                        #"{"scroll":{"at":{"elementID":{"_0":"7"}},"direction":"down","pages":1}}"#)
    }

    /// Recorded off real sky: `sky.set_value({app, element_index: 9, value: "hi"})`
    func testSetValueShape() throws {
        try assertShape(Action.setValue(elementID: "9", value: "hi"),
                        #"{"setValue":{"elementID":"9","value":"hi"}}"#)
    }

    /// Recorded off real sky: `sky.perform_secondary_action({app, element_index: 3, action: "Raise"})`
    func testPerformSecondaryShape() throws {
        try assertShape(Action.performSecondaryAction(action: "Raise", elementID: "3"),
                        #"{"performSecondaryAction":{"action":"Raise","elementID":"3"}}"#)
    }

    /// Recorded off real sky: `sky.select_text({app, element_index: 2, text: "hi", prefix: "a", suffix: "b"})`
    /// ⇒ with no selection_type passed, sky fills in the default `"text"`.
    func testSelectTextShape() throws {
        try assertShape(
            Action.selectText(elementID: "2", text: "hi", prefix: "a", suffix: "b", selection: "text"),
            #"{"selectText":{"elementID":"2","text":"hi","prefix":"a","suffix":"b","selection":"text"}}"#)
    }

    func testMouseButtonRawValues() {
        // sky y2(): left|l → 0, right|r → 1, middle|m → 2
        XCTAssertEqual(MouseButton.left.rawValue, 0)
        XCTAssertEqual(MouseButton.right.rawValue, 1)
        XCTAssertEqual(MouseButton.middle.rawValue, 2)
        XCTAssertEqual(MouseButton.left.name, "left")
        XCTAssertEqual(MouseButton.middle.name, "middle")
    }

    // MARK: - PerformAction request body

    func testPerformActionRequestEnvelope() throws {
        try assertShape(PerformActionRequest(app: "TextEdit", action: .type("hi")),
                        #"{"app":"TextEdit","action":{"type":{"_0":"hi"}}}"#)
    }

    // MARK: - The other direction: decoding the JSON codex sends

    /// A **regression guard**: the JSON below is verbatim what real sky ships (recorded from
    /// `sky.click({element_index:5})`). Before the fix, Swift threw typeMismatch decoding it —
    /// meaning every click died at the wire level.
    func testDecodeCodexClick() throws {
        let json = #"{"click":{"at":{"elementID":{"_0":"5"}},"clickCount":1,"mouseButton":0}}"#
        let a = try JSONDecoder().decode(Action.self, from: Data(json.utf8))
        XCTAssertEqual(a, .click(at: .elementID("5"), clickCount: 1, mouseButton: .left))
    }

    func testDecodeCodexPressKey() throws {
        let a = try JSONDecoder().decode(Action.self, from: Data(#"{"pressKey":{"_0":"Tab"}}"#.utf8))
        XCTAssertEqual(a, .pressKey("Tab"))
    }

    // MARK: - AppState response

    func testAppStateShape() throws {
        try assertShape(AppState(app: "Weather", screenshot: Screenshot(url: "file:///tmp/shot.jpg"), text: "tree"),
                        #"{"app":"Weather","screenshot":{"url":"file:///tmp/shot.jpg"},"text":"tree"}"#)
    }

    // MARK: - framing

    func testFramingRoundTrip() throws {
        let payload = Data("hi".utf8)
        let framed = try Framing.encode(payload)
        XCTAssertEqual([UInt8](framed), [2, 0, 0, 0, 0x68, 0x69], "expected a 4B little-endian length + payload")
        let (msgs, rem) = try Framing.decode(framed)
        XCTAssertEqual(msgs.count, 1)
        XCTAssertEqual(msgs[0], payload)
        XCTAssertEqual(rem.count, 0)
    }

    func testFramingPartialAndMulti() throws {
        let a = try Framing.encode(Data("a".utf8))
        let b = try Framing.encode(Data("bb".utf8))
        var buf = a + b
        buf.append(contentsOf: [3, 0]) // half a length prefix; should be left as remaining
        let (msgs, rem) = try Framing.decode(buf)
        XCTAssertEqual(msgs.map { String(data: $0, encoding: .utf8) }, ["a", "bb"])
        XCTAssertEqual([UInt8](rem), [3, 0])
    }

    // MARK: - Version

    func testVersionConstant() {
        XCTAssertEqual(WireVersion.current, "CodexComputerUseIPC-2")
    }

    func testRequestTypeRawValues() {
        XCTAssertEqual(RequestType.performAction.rawValue, "ComputerUseIPCAppPerformActionRequest")
        XCTAssertEqual(RequestType.getSkyshot.rawValue, "ComputerUseIPCAppGetSkyshotRequest")
    }
}
