import Foundation
import OpenComputerUseKit
import XCTest
@testable import OperonComputerUseServer

final class AppListTests: XCTestCase {
    func testCatalogPreservesTheNativeSkyListAppsShape() throws {
        var components = DateComponents()
        components.calendar = Calendar(identifier: .gregorian)
        components.timeZone = TimeZone(secondsFromGMT: 0)
        components.year = 2026
        components.month = 7
        components.day = 17
        let lastUsed = try XCTUnwrap(components.date)
        let input = ListedAppDescriptor(
            name: "Example App",
            bundleIdentifier: "com.example.app",
            isRunning: true,
            isFrontmost: false,
            lastUsed: lastUsed,
            uses: 12
        )

        let result = try XCTUnwrap(AppList.catalog(from: [input]).first)
        XCTAssertEqual(result["bundleIdentifier"] as? String, "com.example.app")
        XCTAssertEqual(result["displayName"] as? String, "Example App")
        XCTAssertEqual(result["isRunning"] as? Bool, true)
        XCTAssertEqual(result["isFrontmost"] as? Bool, false)
        XCTAssertEqual(result["lastUsedDate"] as? String, "2026-07-17")
        XCTAssertEqual(result["useCount"] as? Int, 12)
    }

    func testCatalogOmitsOptionalUsageFieldsWhenUnavailable() throws {
        let input = ListedAppDescriptor(
            name: "Example App",
            bundleIdentifier: "com.example.app",
            isRunning: false,
            isFrontmost: false,
            lastUsed: nil,
            uses: nil
        )

        let result = try XCTUnwrap(AppList.catalog(from: [input]).first)
        XCTAssertNil(result["lastUsedDate"])
        XCTAssertNil(result["useCount"])
    }
}
