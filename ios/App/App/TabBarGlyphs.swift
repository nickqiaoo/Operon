import CoreGraphics
#if canImport(UIKit)
import UIKit
#endif

/// The tab bar's own icons, drawn here instead of taken from SF Symbols: the
/// stock `message` / `sparkles` / `ellipsis` set is what every sample app
/// ships with.
///
/// One family: a container shape with marks inside it. Unselected tabs stroke
/// both; the selected tab fills the container and cuts the marks out of it,
/// the way the system swaps an SF Symbol for its `.fill` variant. The chat
/// bubble carries the `>_` of the app icon.
///
/// Geometry is on a 24-unit grid, y down, and plain CoreGraphics so a macOS
/// script can render the same code for review.
enum TabGlyph: String, CaseIterable {
    case chats, assistant, channel, changes, more

    static let grid: CGFloat = 24
    private static let line: CGFloat = 1.75

    /// Draws into a context whose origin is the glyph's top-left and whose
    /// user space is `size` points square, y down.
    func draw(in ctx: CGContext, size: CGFloat, filled: Bool) {
        ctx.saveGState()
        defer { ctx.restoreGState() }
        ctx.scaleBy(x: size / Self.grid, y: size / Self.grid)
        ctx.setLineWidth(Self.line)
        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)

        let (container, marks, dots) = shapes()
        if filled {
            // Stroke as well as fill so the filled shape keeps the outline's
            // outer edge instead of shrinking by half a line.
            ctx.addPath(container)
            ctx.drawPath(using: .fillStroke)
            ctx.setBlendMode(.clear)
            ctx.setLineWidth(Self.line + 0.25)
        } else {
            ctx.addPath(container)
            ctx.strokePath()
        }
        if let marks {
            ctx.addPath(marks)
            ctx.strokePath()
        }
        if let dots {
            ctx.addPath(dots)
            ctx.fillPath()
        }
    }

    /// Container, stroked marks, filled marks.
    private func shapes() -> (CGPath, CGPath?, CGPath?) {
        switch self {
        case .chats:
            // Bubble with its tail at the lower left, holding the icon's `>_`.
            let bubble = CGMutablePath()
            bubble.move(to: CGPoint(x: 12, y: 3.75))
            bubble.addArc(tangent1End: CGPoint(x: 20.25, y: 3.75), tangent2End: CGPoint(x: 20.25, y: 16.5), radius: 4)
            bubble.addArc(tangent1End: CGPoint(x: 20.25, y: 16.5), tangent2End: CGPoint(x: 3.75, y: 16.5), radius: 4)
            bubble.addLine(to: CGPoint(x: 11, y: 16.5))
            bubble.addLine(to: CGPoint(x: 7, y: 20.25))
            bubble.addLine(to: CGPoint(x: 7, y: 16.5))
            bubble.addArc(tangent1End: CGPoint(x: 3.75, y: 16.5), tangent2End: CGPoint(x: 3.75, y: 3.75), radius: 3.25)
            bubble.addArc(tangent1End: CGPoint(x: 3.75, y: 3.75), tangent2End: CGPoint(x: 20.25, y: 3.75), radius: 4)
            bubble.closeSubpath()
            let prompt = CGMutablePath()
            prompt.move(to: CGPoint(x: 8.25, y: 7.75))
            prompt.addLine(to: CGPoint(x: 10.75, y: 10.1))
            prompt.addLine(to: CGPoint(x: 8.25, y: 12.45))
            prompt.move(to: CGPoint(x: 13, y: 12.45))
            prompt.addLine(to: CGPoint(x: 16, y: 12.45))
            return (bubble, prompt, nil)

        case .assistant:
            // A face: round head, two eyes.
            let head = CGPath(ellipseIn: CGRect(x: 3.5, y: 3.5, width: 17, height: 17), transform: nil)
            let eyes = CGMutablePath()
            for x in [9.25, 14.75] as [CGFloat] {
                eyes.move(to: CGPoint(x: x, y: 9.5))
                eyes.addLine(to: CGPoint(x: x, y: 12.5))
            }
            return (head, eyes, nil)

        case .channel:
            // A board: frame with three lanes hanging from the top.
            let frame = CGPath(roundedRect: CGRect(x: 3.75, y: 3.75, width: 16.5, height: 16.5), cornerWidth: 4, cornerHeight: 4, transform: nil)
            let lanes = CGMutablePath()
            for (x, end) in [(8.25, 16.25), (12, 14), (15.75, 11.25)] as [(CGFloat, CGFloat)] {
                lanes.move(to: CGPoint(x: x, y: 7.75))
                lanes.addLine(to: CGPoint(x: x, y: end))
            }
            return (frame, lanes, nil)

        case .changes:
            // A page with a `+` line over a `−` line.
            let page = CGPath(roundedRect: CGRect(x: 4.75, y: 3.25, width: 14.5, height: 17.5), cornerWidth: 4, cornerHeight: 4, transform: nil)
            let diff = CGMutablePath()
            diff.move(to: CGPoint(x: 9.5, y: 9))
            diff.addLine(to: CGPoint(x: 14.5, y: 9))
            diff.move(to: CGPoint(x: 12, y: 6.5))
            diff.addLine(to: CGPoint(x: 12, y: 11.5))
            diff.move(to: CGPoint(x: 9.5, y: 15.5))
            diff.addLine(to: CGPoint(x: 14.5, y: 15.5))
            return (page, diff, nil)

        case .more:
            // Three tiles and a dot: everything else.
            let tiles = CGMutablePath()
            let side: CGFloat = 6.25
            for origin in [CGPoint(x: 3.75, y: 3.75), CGPoint(x: 14, y: 3.75), CGPoint(x: 3.75, y: 14)] {
                tiles.addRoundedRect(in: CGRect(origin: origin, size: CGSize(width: side, height: side)), cornerWidth: 2, cornerHeight: 2)
            }
            tiles.addEllipse(in: CGRect(x: 14, y: 14, width: side, height: side))
            return (tiles, nil, nil)
        }
    }
}

#if canImport(UIKit)
extension TabGlyph {
    /// Points square, the size Apple gives for custom tab bar glyphs.
    static let pointSize: CGFloat = 25

    func image(filled: Bool) -> UIImage {
        let size = CGSize(width: Self.pointSize, height: Self.pointSize)
        let image = UIGraphicsImageRenderer(size: size).image { context in
            UIColor.black.setFill()
            UIColor.black.setStroke()
            draw(in: context.cgContext, size: Self.pointSize, filled: filled)
        }
        return image.withRenderingMode(.alwaysTemplate)
    }
}
#endif
