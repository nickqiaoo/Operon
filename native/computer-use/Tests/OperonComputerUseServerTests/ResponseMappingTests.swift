import Foundation
import XCTest
@testable import OpenComputerUseKit
@testable import OperonComputerUseServer

final class ResponseMappingTests: XCTestCase {
    func testAppStateMaterializesScreenshotAsFileURL() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("operon-response-mapping-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let screenshotBytes = Data([0x01, 0x02, 0x03])
        let result = ToolCallResult(content: [
            .text("[1] window"),
            .jpegImage(screenshotBytes),
        ])

        let response = try ResponseMapping.appStateJSON(
            from: result,
            app: "TextEdit",
            screenshotDirectory: directory
        )
        let skyshot = try XCTUnwrap(response["skyshot"] as? [String: Any])
        let screenshot = try XCTUnwrap(skyshot["screenshot"] as? [String: Any])
        let urlString = try XCTUnwrap(screenshot["url"] as? String)
        let fileURL = try XCTUnwrap(URL(string: urlString))

        XCTAssertEqual(fileURL.scheme, "file")
        XCTAssertEqual(fileURL.pathExtension, "jpg")
        XCTAssertEqual(try Data(contentsOf: fileURL), screenshotBytes)
        XCTAssertNil(screenshot["mimeType"])
        XCTAssertEqual(skyshot["text"] as? String, "[1] window")
    }

    func testAppStateWithoutImageHasNoScreenshot() throws {
        let response = try ResponseMapping.appStateJSON(
            from: .text("tree"),
            app: "TextEdit"
        )
        let skyshot = try XCTUnwrap(response["skyshot"] as? [String: Any])

        XCTAssertNil(skyshot["screenshot"])
        XCTAssertEqual(skyshot["text"] as? String, "tree")
    }
}
