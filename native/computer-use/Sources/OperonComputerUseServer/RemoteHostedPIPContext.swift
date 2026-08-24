import AppKit
import CoreImage
import CoreVideo
import IOSurface
import OpenComputerUseKit
import QuartzCore

/// Producer side of the remote Core Animation model used by Codex.
/// The Electron host attaches this context with CALayerHost; frame updates stay
/// in WindowServer/Core Animation and never cross stdout as encoded images.
@MainActor
final class RemoteHostedPIPContext {
    private let context: NSObject
    private let rootLayer = CALayer()
    private let contentLayer = CALayer()
    private let cursorLayer = CALayer()
    private let renderContext = CIContext(options: [.useSoftwareRenderer: false])
    private var retainedFallbackSurface: IOSurface?

    let contextID: UInt32
    private(set) var size = CGSize.zero

    init?() {
        guard let contextClass = NSClassFromString("CAContext") as? NSObject.Type,
              let unmanaged = contextClass.perform(NSSelectorFromString("remoteContext")),
              let context = unmanaged.takeUnretainedValue() as? NSObject
        else {
            return nil
        }

        rootLayer.isGeometryFlipped = true
        rootLayer.masksToBounds = true
        contentLayer.contentsGravity = .resize
        rootLayer.addSublayer(contentLayer)

        cursorLayer.contentsGravity = .resizeAspect
        cursorLayer.opacity = 0
        if let cursorImage = NSCursor.arrow.image.cgImage(
            forProposedRect: nil,
            context: nil,
            hints: nil
        ) {
            cursorLayer.contents = cursorImage
        }
        rootLayer.addSublayer(cursorLayer)

        context.setValue(rootLayer, forKey: "layer")
        guard let identifier = context.value(forKey: "contextId") as? NSNumber,
              identifier.uint32Value != 0
        else {
            context.setValue(nil, forKey: "layer")
            return nil
        }

        self.context = context
        self.contextID = identifier.uint32Value
    }

    func invalidate() {
        context.setValue(nil, forKey: "layer")
        if context.responds(to: NSSelectorFromString("invalidate")) {
            context.perform(NSSelectorFromString("invalidate"))
        }
    }

    @discardableResult
    func present(_ frame: LiveWindowSurfaceFrame) -> Bool {
        retainedFallbackSurface = nil
        return present(surface: frame.surface, width: frame.width, height: frame.height)
    }

    @discardableResult
    func present(cgImage: CGImage) -> Bool {
        guard let surface = makeSurface(for: cgImage) else { return false }
        retainedFallbackSurface = surface
        renderContext.render(
            CIImage(cgImage: cgImage),
            to: surface,
            bounds: CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height),
            colorSpace: CGColorSpace(name: CGColorSpace.sRGB)
        )
        return present(surface: surface, width: cgImage.width, height: cgImage.height)
    }

    func updateCursor(_ presentation: OpenComputerUseVisualCursorPresentation) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if presentation.active, size.width > 0, size.height > 0 {
            let imageSize = NSCursor.arrow.image.size
            let width = max(18, min(28, size.width * 0.055))
            let height = width * max(imageSize.height, 1) / max(imageSize.width, 1)
            let hotSpot = NSCursor.arrow.hotSpot
            cursorLayer.bounds = CGRect(x: 0, y: 0, width: width, height: height)
            cursorLayer.anchorPoint = CGPoint(
                x: hotSpot.x / max(imageSize.width, 1),
                y: hotSpot.y / max(imageSize.height, 1)
            )
            cursorLayer.position = CGPoint(
                x: presentation.normalizedX * size.width,
                y: presentation.normalizedY * size.height
            )
            cursorLayer.setAffineTransform(CGAffineTransform(rotationAngle: presentation.rotation))
            cursorLayer.opacity = 1
        } else {
            cursorLayer.opacity = 0
        }
        CATransaction.commit()
    }

    private func present(surface: IOSurface, width: Int, height: Int) -> Bool {
        guard width > 0, height > 0 else { return false }
        let nextSize = CGSize(width: width, height: height)
        let changed = nextSize != size
        size = nextSize

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        rootLayer.bounds = CGRect(origin: .zero, size: nextSize)
        contentLayer.frame = rootLayer.bounds
        contentLayer.contents = surface
        rootLayer.setNeedsDisplay()
        CATransaction.commit()
        return changed
    }

    private func makeSurface(for image: CGImage) -> IOSurface? {
        let width = image.width
        let bytesPerRow = width * 4
        let properties = NSMutableDictionary()
        properties[kIOSurfaceWidth] = width
        properties[kIOSurfaceHeight] = image.height
        properties[kIOSurfaceBytesPerElement] = 4
        properties[kIOSurfaceBytesPerRow] = bytesPerRow
        properties[kIOSurfacePixelFormat] = kCVPixelFormatType_32BGRA
        return IOSurfaceCreate(properties)
    }
}
