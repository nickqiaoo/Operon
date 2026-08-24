import AppKit
import Foundation

private struct PointState: Codable {
    let x: Double
    let y: Double
}

private struct RectState: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

private struct FixtureState: Codable {
    let pid: Int32
    let ready: Bool
    let incrementCount: Int
    let coordinateCount: Int
    let inputValue: String
    let keyValue: String
    let lastKey: String
    let lastKeyCode: UInt16?
    let searchValue: String
    let searchSubmitCount: Int
    let scrollOffsetY: Double
    let dragCount: Int
    let dragStart: PointState?
    let dragEnd: PointState?
    let toggleValue: Bool
    let selectedLocation: Int
    let selectedLength: Int
    let selectedText: String
    let focusedIdentifier: String?
    let keyWindow: Bool
    let windowWidth: Double
    let windowHeight: Double
    let elementFrames: [String: RectState]
}

@MainActor
private final class KeyCaptureTextField: NSTextField {
    var lastKey = ""
    var lastKeyCode: UInt16?

    override func keyDown(with event: NSEvent) {
        lastKey = event.charactersIgnoringModifiers ?? event.characters ?? ""
        lastKeyCode = event.keyCode
        super.keyDown(with: event)
    }
}

@MainActor
private final class DragPadView: NSView {
    private(set) var dragCount = 0
    private(set) var dragStart: CGPoint?
    private(set) var dragEnd: CGPoint?

    override var acceptsFirstResponder: Bool { true }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }

    override func mouseDown(with event: NSEvent) {
        dragStart = convert(event.locationInWindow, from: nil)
        dragEnd = dragStart
    }

    override func mouseDragged(with event: NSEvent) {
        dragEnd = convert(event.locationInWindow, from: nil)
    }

    override func mouseUp(with event: NSEvent) {
        dragEnd = convert(event.locationInWindow, from: nil)
        dragCount += 1
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedRed: 0.94, green: 0.96, blue: 0.99, alpha: 1).setFill()
        bounds.fill()
        NSColor(calibratedRed: 0.55, green: 0.65, blue: 0.78, alpha: 1).setStroke()
        let border = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 8, yRadius: 8)
        border.lineWidth = 1
        border.stroke()
    }
}

@MainActor
private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

@MainActor
private final class FixtureAppDelegate: NSObject, NSApplicationDelegate {
    private let statePath: String
    private var window: NSWindow?
    private var incrementCount = 0
    private var coordinateCount = 0
    private var searchSubmitCount = 0
    private var timer: Timer?

    private let inputField = NSTextField(string: "")
    private let keyField = KeyCaptureTextField(string: "")
    private let searchField = NSSearchField(string: "")
    private let scrollView = NSScrollView()
    private let dragPad = DragPadView()
    private let toggle = NSButton(checkboxWithTitle: "Enable fixture option", target: nil, action: nil)
    private let textView = NSTextView()

    init(statePath: String) {
        self.statePath = statePath
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildWindow()
        writeState()
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.writeState()
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    private func buildWindow() {
        let window = NSWindow(
            contentRect: NSRect(x: 180, y: 140, width: 760, height: 680),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Operon CUA AppKit Fixture"
        window.isReleasedWhenClosed = false
        window.setAccessibilityIdentifier("fixture.window")

        guard let content = window.contentView else { return }

        let title = NSTextField(labelWithString: "Computer Use E2E Fixture")
        title.font = .systemFont(ofSize: 22, weight: .semibold)
        title.frame = NSRect(x: 28, y: 618, width: 360, height: 32)
        title.setAccessibilityIdentifier("fixture.title")
        content.addSubview(title)

        let incrementButton = NSButton(title: "Increment", target: self, action: #selector(increment))
        incrementButton.frame = NSRect(x: 28, y: 560, width: 130, height: 34)
        incrementButton.setAccessibilityIdentifier("fixture.increment")
        content.addSubview(incrementButton)

        let coordinateButton = NSButton(title: "Coordinate Click", target: self, action: #selector(coordinateClick))
        coordinateButton.frame = NSRect(x: 174, y: 560, width: 150, height: 34)
        coordinateButton.setAccessibilityIdentifier("fixture.coordinate")
        content.addSubview(coordinateButton)

        addLabel("Set Value / Type Text", x: 28, y: 520, to: content)
        inputField.frame = NSRect(x: 28, y: 484, width: 296, height: 28)
        inputField.placeholderString = "Editable input"
        inputField.setAccessibilityIdentifier("fixture.input")
        content.addSubview(inputField)

        addLabel("Press Key", x: 28, y: 446, to: content)
        keyField.frame = NSRect(x: 28, y: 410, width: 296, height: 28)
        keyField.placeholderString = "Keyboard capture"
        keyField.setAccessibilityIdentifier("fixture.key-capture")
        content.addSubview(keyField)

        addLabel("Search Autosubmit", x: 28, y: 372, to: content)
        searchField.frame = NSRect(x: 28, y: 336, width: 296, height: 28)
        searchField.placeholderString = "Search fixture"
        searchField.target = self
        searchField.action = #selector(submitSearch)
        searchField.setAccessibilityIdentifier("fixture.search")
        content.addSubview(searchField)

        toggle.frame = NSRect(x: 28, y: 292, width: 220, height: 24)
        toggle.setAccessibilityIdentifier("fixture.toggle")
        content.addSubview(toggle)

        addLabel("Scrollable Content", x: 362, y: 600, to: content)
        scrollView.frame = NSRect(x: 362, y: 390, width: 366, height: 202)
        scrollView.hasVerticalScroller = true
        scrollView.borderType = .bezelBorder
        scrollView.setAccessibilityIdentifier("fixture.scroll")
        let scrollDocument = FlippedView(frame: NSRect(x: 0, y: 0, width: 344, height: 900))
        for row in 0..<30 {
            let label = NSTextField(labelWithString: "Scrollable row \(row + 1)")
            label.frame = NSRect(x: 12, y: CGFloat(row * 29 + 8), width: 260, height: 20)
            scrollDocument.addSubview(label)
        }
        scrollView.documentView = scrollDocument
        content.addSubview(scrollView)

        addLabel("Drag Pad", x: 362, y: 352, to: content)
        dragPad.frame = NSRect(x: 362, y: 250, width: 366, height: 94)
        dragPad.setAccessibilityElement(true)
        dragPad.setAccessibilityRole(.group)
        dragPad.setAccessibilityLabel("Drag Pad")
        dragPad.setAccessibilityIdentifier("fixture.drag")
        content.addSubview(dragPad)

        addLabel("Select Text", x: 362, y: 212, to: content)
        let textScroll = NSScrollView(frame: NSRect(x: 362, y: 58, width: 366, height: 146))
        textScroll.hasVerticalScroller = true
        textScroll.borderType = .bezelBorder
        textScroll.setAccessibilityIdentifier("fixture.selectable-container")
        textView.string = "alpha target omega | alpha second omega"
        textView.isEditable = true
        textView.isSelectable = true
        textView.setAccessibilityIdentifier("fixture.selectable")
        textScroll.documentView = textView
        content.addSubview(textScroll)

        window.makeFirstResponder(keyField)
        window.orderBack(nil)
        self.window = window
    }

    private func addLabel(_ text: String, x: CGFloat, y: CGFloat, to content: NSView) {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 12, weight: .medium)
        label.textColor = .secondaryLabelColor
        label.frame = NSRect(x: x, y: y, width: 250, height: 20)
        content.addSubview(label)
    }

    @objc private func increment() {
        incrementCount += 1
        writeState()
    }

    @objc private func coordinateClick() {
        coordinateCount += 1
        writeState()
    }

    @objc private func submitSearch() {
        searchSubmitCount += 1
        writeState()
    }

    private func writeState() {
        let selection = textView.selectedRange()
        let fullText = textView.string as NSString
        let selectedText: String
        if selection.location != NSNotFound,
           selection.location + selection.length <= fullText.length {
            selectedText = fullText.substring(with: selection)
        } else {
            selectedText = ""
        }
        let state = FixtureState(
            pid: ProcessInfo.processInfo.processIdentifier,
            ready: window?.isVisible == true,
            incrementCount: incrementCount,
            coordinateCount: coordinateCount,
            inputValue: inputField.stringValue,
            keyValue: keyField.stringValue,
            lastKey: keyField.lastKey,
            lastKeyCode: keyField.lastKeyCode,
            searchValue: searchField.stringValue,
            searchSubmitCount: searchSubmitCount,
            scrollOffsetY: Double(scrollView.contentView.bounds.origin.y),
            dragCount: dragPad.dragCount,
            dragStart: dragPad.dragStart.map { PointState(x: Double($0.x), y: Double($0.y)) },
            dragEnd: dragPad.dragEnd.map { PointState(x: Double($0.x), y: Double($0.y)) },
            toggleValue: toggle.state == .on,
            selectedLocation: selection.location == NSNotFound ? -1 : selection.location,
            selectedLength: selection.length,
            selectedText: selectedText,
            focusedIdentifier: (window?.firstResponder as? NSView)?.accessibilityIdentifier(),
            keyWindow: window?.isKeyWindow == true,
            windowWidth: Double(window?.frame.width ?? 0),
            windowHeight: Double(window?.frame.height ?? 0),
            elementFrames: [
                "fixture.increment": screenshotFrame(of: contentView(identifier: "fixture.increment")),
                "fixture.coordinate": screenshotFrame(of: contentView(identifier: "fixture.coordinate")),
                "fixture.input": screenshotFrame(of: inputField),
                "fixture.key-capture": screenshotFrame(of: keyField),
                "fixture.search": screenshotFrame(of: searchField),
                "fixture.scroll": screenshotFrame(of: scrollView),
                "fixture.drag": screenshotFrame(of: dragPad),
                "fixture.toggle": screenshotFrame(of: toggle),
                "fixture.selectable": screenshotFrame(of: textView),
            ].compactMapValues { $0 }
        )

        do {
            let data = try JSONEncoder().encode(state)
            try data.write(to: URL(fileURLWithPath: statePath), options: .atomic)
        } catch {
            FileHandle.standardError.write(Data("fixture state write failed: \(error)\n".utf8))
        }
    }

    private func contentView(identifier: String) -> NSView? {
        window?.contentView?.subviews.first(where: {
            $0.accessibilityIdentifier() == identifier
        })
    }

    private func screenshotFrame(of view: NSView?) -> RectState? {
        guard let view, let window else { return nil }
        let frame = view.convert(view.bounds, to: nil)
        return RectState(
            x: Double(frame.minX),
            y: Double(window.frame.height - frame.maxY),
            width: Double(frame.width),
            height: Double(frame.height)
        )
    }
}

private func statePathFromArguments() -> String {
    let arguments = CommandLine.arguments
    if let index = arguments.firstIndex(of: "--state-file"), index + 1 < arguments.count {
        return arguments[index + 1]
    }
    if let path = ProcessInfo.processInfo.environment["OPERON_CUA_FIXTURE_STATE_PATH"], !path.isEmpty {
        return path
    }
    return URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("operon-cua-appkit-fixture-state.json")
        .path
}

let application = NSApplication.shared
private let delegate = FixtureAppDelegate(statePath: statePathFromArguments())
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
