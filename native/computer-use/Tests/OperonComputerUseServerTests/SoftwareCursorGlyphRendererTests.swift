import AppKit
import XCTest
@testable import OpenComputerUseKit

final class SoftwareCursorGlyphRendererTests: XCTestCase {
    func testProceduralPointerTipRendersTowardUpperLeft() {
        let rect = CGRect(origin: .zero, size: SoftwareCursorGlyphMetrics.pointerSize)
        let path = SoftwareCursorGlyphRenderer.pointerPath(in: rect)

        // The left boundary has 30 rows. Its final row is the traced arrow tip
        // at source coordinate (13, 10), before the shipping artwork rotation.
        var associatedPoints = [NSPoint](repeating: .zero, count: 3)
        let element = path.element(at: 29, associatedPoints: &associatedPoints)
        XCTAssertEqual(element, .lineTo)

        let tip = associatedPoints[0]
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let angle = SoftwareCursorGlyphMetrics.pointerArtworkRotation
        let offset = CGVector(dx: tip.x - center.x, dy: tip.y - center.y)
        let renderedTip = CGPoint(
            x: center.x + (offset.dx * cos(angle)) - (offset.dy * sin(angle)),
            y: center.y + (offset.dx * sin(angle)) + (offset.dy * cos(angle))
        )

        XCTAssertLessThan(renderedTip.x, center.x, "The resting pointer tip must point left")
        XCTAssertGreaterThan(renderedTip.y, center.y, "The resting pointer tip must point up")
    }
}
