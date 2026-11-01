import UIKit
import Capacitor
import UniformTypeIdentifiers
import PhotosUI

/// A single native editor shared by the visible conversation. The DOM reserves
/// its height; only UIKit moves the editor during the keyboard animation.
@objc(NativeComposerPlugin)
public final class NativeComposerPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate, PHPickerViewControllerDelegate {
    public let identifier = "NativeComposerPlugin"
    public let jsName = "NativeComposer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "layout", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hide", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setScrollButton", returnType: CAPPluginReturnPromise),
    ]
    private var editor: NativeComposerView?
    private var pickingOwner: String?
    private var scrollButton: UIVisualEffectView?
    private var scrollOwner = ""

    @objc func setScrollButton(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let id = call.getString("id") else { call.resolve(); return }
            guard call.getBool("visible") == true else {
                if self.scrollOwner == id { self.scrollButton?.removeFromSuperview() }
                call.resolve()
                return
            }
            guard let root = self.bridge?.viewController?.parent as? ShellRootController else {
                call.reject("Native shell is unavailable")
                return
            }
            let size = CGFloat(call.getDouble("size") ?? 36)
            if self.scrollButton == nil {
                let material: UIVisualEffect
                if #available(iOS 26.0, *) {
                    let glass = UIGlassEffect(style: .regular)
                    glass.isInteractive = true
                    material = glass
                } else { material = UIBlurEffect(style: .systemMaterial) }
                let view = UIVisualEffectView(effect: material)
                view.clipsToBounds = true
                let button = UIButton(type: .system)
                button.setImage(UIImage(systemName: "arrow.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 16, weight: .medium)), for: .normal)
                button.tintColor = .label
                button.accessibilityLabel = "Scroll to bottom"
                button.addAction(UIAction { [weak self] _ in
                    guard let self else { return }
                    self.notifyListeners("scrollToBottom", data: ["id": self.scrollOwner])
                }, for: .touchUpInside)
                view.contentView.addSubview(button)
                self.scrollButton = view
            }
            guard let view = self.scrollButton else { call.resolve(); return }
            self.scrollOwner = id
            view.frame = CGRect(x: CGFloat(call.getDouble("x") ?? 0), y: CGFloat(call.getDouble("y") ?? 0), width: size, height: size)
            view.layer.cornerRadius = size / 2
            view.contentView.subviews.first?.frame = view.bounds
            if view.superview == nil { root.view.insertSubview(view, aboveSubview: root.bridgeController.view) }
            call.resolve()
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let root = self.bridge?.viewController?.parent as? ShellRootController else {
                call.reject("Native shell is unavailable")
                return
            }
            let editor = self.editor ?? NativeComposerView()
            self.editor = editor
            editor.onEvent = { [weak self] name, data in self?.notifyListeners(name, data: data) }
            editor.onPickFiles = { [weak self] photos in self?.pickFiles(photos: photos) }
            if editor.superview == nil {
                root.view.insertSubview(editor, aboveSubview: root.bridgeController.view)
            }
            editor.configure(call.jsObjectRepresentation)
            call.resolve()
        }
    }

    @objc func layout(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let editor = self?.editor, editor.owner == call.getString("id") else { call.resolve(); return }
            editor.setAnchor(
                x: CGFloat(call.getDouble("x") ?? 12), width: CGFloat(call.getDouble("width") ?? 0),
                bottom: CGFloat(call.getDouble("bottom") ?? 8), keyboardOpen: call.getBool("keyboardOpen") ?? false
            )
            call.resolve()
        }
    }

    @objc func hide(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            if let editor = self?.editor, editor.owner == call.getString("id") {
                editor.endEditing(true)
                editor.flushChange()
                editor.removeFromSuperview()
            }
            call.resolve()
        }
    }

    private func pickFiles(photos: Bool) {
        guard let presenter = bridge?.viewController?.parent, let editor else { return }
        pickingOwner = editor.owner
        editor.endEditing(true)
        if photos {
            var config = PHPickerConfiguration()
            config.filter = .images
            config.selectionLimit = 10
            let picker = PHPickerViewController(configuration: config)
            picker.delegate = self
            presenter.present(picker, animated: true)
        } else {
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
            picker.allowsMultipleSelection = true
            picker.delegate = self
            presenter.present(picker, animated: true)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let owner = pickingOwner else { return }
        pickingOwner = nil
        // File reads/base64 encoding never run on the editing thread.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var files: [JSObject] = []
            var oversized = false
            for url in urls {
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 10 * 1024 * 1024 else {
                    oversized = true
                    continue
                }
                guard let data = try? Data(contentsOf: url) else { continue }
                let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                files.append(["name": url.lastPathComponent, "type": type, "url": "data:\(type);base64,\(data.base64EncodedString())"])
            }
            let result = files
            let showSizeWarning = oversized
            DispatchQueue.main.async {
                self?.notifyListeners("files", data: ["id": owner, "files": result])
                if showSizeWarning { self?.showFileWarning() }
            }
        }
    }

    public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let owner = pickingOwner else { return }
        pickingOwner = nil
        for result in results {
            result.itemProvider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { [weak self] url, _ in
                guard let url, let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize else { return }
                guard size <= 10 * 1024 * 1024 else {
                    DispatchQueue.main.async { self?.showFileWarning() }
                    return
                }
                guard let data = try? Data(contentsOf: url) else { return }
                let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "image/jpeg"
                let file: JSObject = ["name": url.lastPathComponent, "type": type, "url": "data:\(type);base64,\(data.base64EncodedString())"]
                DispatchQueue.main.async { self?.notifyListeners("files", data: ["id": owner, "files": [file]]) }
            }
        }
    }

    private func showFileWarning() {
        let alert = UIAlertController(title: "File too large", message: "Choose files smaller than 10 MB.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        bridge?.viewController?.parent?.present(alert, animated: true)
    }
}

private final class ComposerTokenContainer: UIView {
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        subviews.contains { !$0.isHidden && $0.frame.contains(point) }
    }
}

final class NativeComposerView: UIView, UITextViewDelegate {
    private(set) var owner = ""
    private var revision = 0
    private let glass: UIVisualEffectView
    let textView = UITextView()
    private let placeholder = UILabel()
    private let attach = UIButton(type: .system)
    private let send = UIButton(type: .system)
    private let steer = UIButton(type: .system)
    private let options = UIButton(type: .system)
    private let tokens = UIScrollView()
    private let inlineTokens = ComposerTokenContainer()
    private let suggestionPanel = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
    private let suggestions = UIScrollView()
    private var state: JSObject = [:]
    private var tokenItems: [(id: String, title: String)] = []
    private var inlineTokenItems: [(id: String, title: String)] = []
    private var suggestionItems: [JSObject] = []
    private var draftSync: DispatchWorkItem?
    private var anchorX: CGFloat = 12
    private var anchorWidth: CGFloat = 0
    private var closedBottom: CGFloat = 8
    private var keyboardTop: CGFloat?
    private var lastHeight: CGFloat = 0
    private var applyingText = false
    private var submissionPending = false
    var onEvent: ((String, JSObject) -> Void)?
    var onPickFiles: ((Bool) -> Void)?

    override init(frame: CGRect) {
        if #available(iOS 26.0, *) {
            glass = UIVisualEffectView(effect: nil)
        } else {
            glass = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
        }
        super.init(frame: frame)
        isHidden = true
        accessibilityIdentifier = "native-chat-composer"
        glass.layer.cornerRadius = 28
        glass.layer.cornerCurve = .continuous
        glass.clipsToBounds = true
        addSubview(glass)
        for child in [tokens, attach, textView, placeholder, send, steer, options] {
            glass.contentView.addSubview(child)
        }
        suggestionPanel.layer.cornerRadius = 18
        suggestionPanel.layer.cornerCurve = .continuous
        suggestionPanel.clipsToBounds = true
        suggestionPanel.layer.borderWidth = 0.5
        suggestionPanel.layer.borderColor = UIColor.separator.withAlphaComponent(0.25).cgColor
        suggestionPanel.accessibilityIdentifier = "native-composer-suggestions"
        suggestionPanel.contentView.addSubview(suggestions)
        addSubview(suggestionPanel)
        textView.backgroundColor = .clear
        textView.font = .preferredFont(forTextStyle: .body)
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = 28
        textView.typingAttributes = [
            .font: UIFont.preferredFont(forTextStyle: .body),
            .foregroundColor: UIColor.label,
            .paragraphStyle: paragraph,
        ]
        textView.adjustsFontForContentSizeCategory = true
        textView.textColor = .label
        textView.tintColor = brandUIColor
        textView.textContainerInset = UIEdgeInsets(top: 10, left: 0, bottom: 10, right: 0)
        textView.textContainer.lineFragmentPadding = 0
        textView.keyboardDismissMode = .interactive
        textView.accessibilityLabel = "Message"
        textView.accessibilityIdentifier = "native-message-input"
        textView.delegate = self
        textView.addSubview(inlineTokens)
        placeholder.font = textView.font
        placeholder.textColor = .placeholderText
        placeholder.isUserInteractionEnabled = false
        placeholder.isAccessibilityElement = false
        suggestions.showsVerticalScrollIndicator = true
        suggestions.keyboardDismissMode = .none
        tokens.showsHorizontalScrollIndicator = false
        attach.setImage(UIImage(systemName: "plus"), for: .normal)
        attach.tintColor = brandUIColor
        attach.accessibilityLabel = "Attachments and options"
        attach.showsMenuAsPrimaryAction = true
        // Model / thinking / mode live behind one small button; the current
        // values only show once it is opened, as the menu's header.
        options.setImage(ComposerGlyph.options.image(size: 26), for: .normal)
        options.tintColor = .label
        options.accessibilityLabel = "Model and options"
        options.showsMenuAsPrimaryAction = true
        send.addTarget(self, action: #selector(sendTapped), for: .touchUpInside)
        send.accessibilityIdentifier = "native-send-message"
        steer.setImage(UIImage(systemName: "arrow.up.forward"), for: .normal)
        steer.tintColor = brandUIColor
        steer.accessibilityLabel = "Steer"
        steer.addTarget(self, action: #selector(steerTapped), for: .touchUpInside)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    }

    convenience init() { self.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    deinit { draftSync?.cancel(); NotificationCenter.default.removeObserver(self) }

    func configure(_ next: JSObject) {
        let nextOwner = next["id"] as? String ?? ""
        let changedOwner = owner != nextOwner
        if changedOwner {
            endEditing(true)
            flushChange()
            draftSync?.cancel()
            owner = nextOwner
            revision = next["revision"] as? Int ?? 0
            lastHeight = 0
            submissionPending = false
            closedBottom = superview?.safeAreaInsets.bottom ?? 8
            isHidden = true // Wait for this owner's DOM anchor, rather than flash at the previous chat's position.
        }
        let previous = state
        state = next
        let incoming = next["text"] as? String ?? ""
        // Ignore echoes overtaken by local typing; never replace marked IME text.
        if (changedOwner || next["revision"] as? Int == revision), textView.markedTextRange == nil, incoming != textView.text {
            applyingText = true
            let oldLength = (textView.text as NSString).length
            let selection = textView.selectedRange
            textView.text = incoming
            let newLength = (incoming as NSString).length
            textView.selectedRange = NSRange(location: min(newLength, max(0, selection.location + newLength - oldLength)), length: 0)
            applyingText = false
        }
        if (next["submitting"] as? Bool) == true { submissionPending = true }
        else { submissionPending = false }
        placeholder.text = next["placeholder"] as? String ?? "Message…"
        tokenItems = (next["attachments"] as? [JSObject] ?? []).compactMap { item in
            guard let id = item["id"] as? String, let title = item["title"] as? String else { return nil }
            return ("attachment:\(id)", title)
        }
        inlineTokenItems = (next["skills"] as? [JSObject] ?? []).compactMap { item in
            guard let id = item["id"] as? String, let title = item["title"] as? String else { return nil }
            return ("skill:\(id)", title)
        }
        suggestionItems = next["suggestions"] as? [JSObject] ?? []
        // Rebuilding a token/list while a finger is down would interrupt its tap.
        if changedOwner || !NSArray(array: previous["attachments"] as? [JSObject] ?? []).isEqual(to: next["attachments"] as? [JSObject] ?? []) || !NSArray(array: previous["skills"] as? [JSObject] ?? []).isEqual(to: next["skills"] as? [JSObject] ?? []) { rebuildTokens() }
        if changedOwner || !NSArray(array: previous["suggestions"] as? [JSObject] ?? []).isEqual(to: suggestionItems) { rebuildSuggestions() }
        let menuItems = next["menu"] as? [JSObject] ?? []
        let custom = menuElements(menuItems)
        var attachmentActions: [UIMenuElement] = []
        if next["allowAttachments"] as? Bool == true {
            attachmentActions = [
                UIAction(title: "Photo Library", image: UIImage(systemName: "photo.on.rectangle")) { [weak self] _ in self?.onPickFiles?(true) },
                UIAction(title: "Choose Files", image: UIImage(systemName: "folder")) { [weak self] _ in self?.onPickFiles?(false) },
            ]
        }
        attach.menu = UIMenu(children: attachmentActions)
        attach.isHidden = attachmentActions.isEmpty
        options.menu = UIMenu(children: [UIMenu(title: next["menuTitle"] as? String ?? "", options: .displayInline, children: custom)])
        options.accessibilityValue = next["menuTitle"] as? String
        refresh()
    }

    func setAnchor(x: CGFloat, width: CGFloat, bottom: CGFloat, keyboardOpen: Bool) {
        guard width > 0 else { return }
        anchorX = x
        anchorWidth = width
        if !keyboardOpen { closedBottom = max(0, bottom) }
        isHidden = false
        refresh()
        if #available(iOS 26.0, *), glass.effect == nil {
            // Install the material after it has a frame and a rendered WebView backdrop.
            UIView.animate(withDuration: 0.2) { self.glass.effect = UIGlassEffect(style: .regular) }
        }
    }

    private var running: Bool { state["running"] as? Bool ?? false }
    private var hasDraft: Bool { !textView.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !tokenItems.isEmpty || !inlineTokenItems.isEmpty || state["hasContext"] as? Bool == true }
    private var showsSteer: Bool { running && state["canSteer"] as? Bool == true && !textView.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    /// Focused or holding a draft: the text gets its own full-width row and the
    /// controls move to a row beneath it. Otherwise one compact row.
    private var expanded: Bool { textView.isFirstResponder || hasDraft }

    private func refresh() {
        guard let parent = superview, anchorWidth > 0 else { return }
        let isExpanded = expanded
        let leading: CGFloat = isExpanded || attach.isHidden ? 16 : 52
        let trailing: CGFloat = isExpanded ? 16 : showsSteer ? 90 : 50
        let textWidth = max(40, anchorWidth - leading - trailing)
        let inlineHeight = layoutInlineTokens(width: textWidth)
        let textHeight = min(140, max(40, inlineHeight + 20, ceil(textView.sizeThatFits(CGSize(width: textWidth, height: .greatestFiniteMagnitude)).height)))
        let tokensHeight: CGFloat = tokenItems.isEmpty ? 0 : 34
        let controlsHeight: CGFloat = isExpanded ? 44 : 0
        let total = 16 + tokensHeight + textHeight + controlsHeight
        var bottom = parent.bounds.height - max(8, closedBottom)
        if let keyboardTop, keyboardTop < parent.bounds.height - parent.safeAreaInsets.bottom - 1 {
            bottom = min(bottom, keyboardTop - 6)
        }
        let panelGap: CGFloat = suggestionItems.isEmpty ? 0 : 8
        let availableHeight = max(0, bottom - total - parent.safeAreaInsets.top - 8 - panelGap)
        let panelHeight = suggestionItems.isEmpty ? 0 : min(248, CGFloat(suggestionItems.count) * 48 + 8, availableHeight)
        let composerY = panelHeight + panelGap
        frame = CGRect(x: anchorX, y: bottom - total - composerY, width: anchorWidth, height: total + composerY)
        glass.frame = CGRect(x: 0, y: composerY, width: anchorWidth, height: total)
        suggestionPanel.frame = CGRect(x: 0, y: 0, width: anchorWidth, height: panelHeight)
        suggestionPanel.isHidden = panelHeight == 0
        suggestions.frame = CGRect(x: 4, y: 4, width: anchorWidth - 8, height: max(0, panelHeight - 8))
        tokens.frame = CGRect(x: 12, y: 8, width: anchorWidth - 24, height: tokensHeight)
        tokens.isHidden = tokenItems.isEmpty
        let rowY = 8 + tokensHeight
        textView.frame = CGRect(x: leading, y: rowY, width: textWidth, height: textHeight)
        textView.isScrollEnabled = textHeight >= 140
        alignInlineTokenBaseline()
        // UITextView's fitted height includes extra layout space. Align controls
        // to the actual text line rather than the bottom of that fitted box.
        let caret = textView.caretRect(for: textView.endOfDocument)
        let lineCenter = min(max(caret.midY, 20), textHeight - 20)
        let placeholderHeight = textView.font?.lineHeight ?? 22
        placeholder.frame = CGRect(x: leading, y: rowY + lineCenter - placeholderHeight / 2, width: textWidth, height: placeholderHeight)
        placeholder.isHidden = !textView.text.isEmpty || !inlineTokenItems.isEmpty
        // Compact: controls sit on the text line. Expanded: + on the left, then
        // (right to left) send, options, steer on the row below the text.
        let controlsCenterY = isExpanded ? rowY + textHeight + controlsHeight / 2 : rowY + lineCenter
        attach.frame = CGRect(x: 8, y: controlsCenterY - 20, width: 40, height: 40)
        send.frame = CGRect(x: anchorWidth - 44, y: controlsCenterY - 16, width: 32, height: 32)
        options.isHidden = !isExpanded || (state["menu"] as? [JSObject] ?? []).isEmpty
        options.frame = CGRect(x: anchorWidth - 92, y: controlsCenterY - 22, width: 44, height: 44)
        steer.frame = CGRect(x: (isExpanded && !options.isHidden ? anchorWidth - 134 : anchorWidth - 86), y: controlsCenterY - 20, width: 40, height: 40)
        steer.isHidden = !showsSteer
        let locked = submissionPending || state["submitting"] as? Bool == true
        // Disabling editing would resign first responder and drop the keyboard on every send.
        textView.isEditable = state["disabled"] as? Bool != true
        attach.isEnabled = !locked
        options.isEnabled = !locked
        var config = UIButton.Configuration.filled()
        config.image = UIImage(systemName: locked ? "ellipsis" : running ? "stop.fill" : "arrow.up")
        config.baseBackgroundColor = brandUIColor
        config.baseForegroundColor = .white
        config.cornerStyle = .capsule
        config.contentInsets = .zero
        send.configuration = config
        send.isEnabled = !locked && (running || (hasDraft && state["disabled"] as? Bool != true))
        send.accessibilityLabel = running ? "Stop response" : "Send message"
        steer.isEnabled = !locked
        layoutTokenButtons()
        layoutSuggestionButtons()
        if total != lastHeight {
            lastHeight = total
            onEvent?("resize", ["id": owner, "height": Double(total)])
        }
    }

    private func menuElements(_ items: [JSObject]) -> [UIMenuElement] {
        items.map { item in
            let title = item["title"] as? String ?? ""
            let image = (item["symbol"] as? String).flatMap { ComposerGlyph(rawValue: $0)?.image() ?? UIImage(systemName: $0) }
            if let children = item["children"] as? [JSObject] {
                return UIMenu(title: title, image: image, children: menuElements(children))
            }
            return UIAction(title: title, image: image, attributes: item["disabled"] as? Bool == true ? .disabled : [], state: item["selected"] as? Bool == true ? .on : .off) { [weak self] _ in
                guard let self else { return }
                self.emitAction(item["id"] as? String ?? "")
            }
        }
    }

    private func rebuildTokens() {
        tokens.subviews.forEach { $0.removeFromSuperview() }
        inlineTokens.subviews.forEach { $0.removeFromSuperview() }
        for item in tokenItems + inlineTokenItems {
            let button = UIButton(type: .system)
            let isInline = item.id.hasPrefix("skill:")
            let font = isInline ? UIFont.preferredFont(forTextStyle: .body) : UIFont.systemFont(ofSize: 14, weight: .medium)
            var config = UIButton.Configuration.tinted()
            config.title = item.title
            config.image = UIImage(systemName: isInline ? "xmark" : "xmark.circle.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: isInline ? 10 : 14, weight: .medium))
            config.imagePlacement = .trailing
            config.imagePadding = 6
            config.cornerStyle = isInline ? .fixed : .capsule
            if isInline {
                config.background.cornerRadius = 10
                config.background.backgroundColor = brandUIColor.withAlphaComponent(0.12)
                config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8)
            }
            config.baseForegroundColor = isInline ? brandUIColor : .secondaryLabel
            config.titleLineBreakMode = .byTruncatingTail
            config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
                var outgoing = incoming
                outgoing.font = font
                return outgoing
            }
            button.configuration = config
            button.accessibilityLabel = "Remove \(item.title)"
            button.addAction(UIAction { [weak self] _ in
                guard let self else { return }
                self.emitAction(item.id)
            }, for: .touchUpInside)
            (item.id.hasPrefix("skill:") ? inlineTokens : tokens).addSubview(button)
        }
    }

    /// Reserve space in the text container so the caret and prose flow beside the tokens.
    private func layoutInlineTokens(width: CGFloat) -> CGFloat {
        let rowHeight = max(28, ceil(textView.font?.lineHeight ?? 22))
        var x: CGFloat = 0
        var y: CGFloat = 0
        var paths: [UIBezierPath] = []
        for button in inlineTokens.subviews {
            let tokenWidth = min(max(40, width - 32), button.sizeThatFits(CGSize(width: width, height: rowHeight)).width)
            if x > 0 && x + tokenWidth > width - 24 {
                paths.append(UIBezierPath(rect: CGRect(x: 0, y: y, width: width, height: rowHeight)))
                x = 0
                y += rowHeight
            }
            button.frame = CGRect(x: x, y: y, width: tokenWidth, height: rowHeight)
            x += tokenWidth + 6
        }
        if x > 0 { paths.append(UIBezierPath(rect: CGRect(x: 0, y: y, width: min(width, x), height: rowHeight))) }
        let height = inlineTokenItems.isEmpty ? 0 : y + rowHeight
        inlineTokens.frame = CGRect(x: 0, y: 10, width: width, height: height)
        textView.textContainer.exclusionPaths = paths
        return height
    }

    private func alignInlineTokenBaseline() {
        guard let button = inlineTokens.subviews.first as? UIButton,
              let font = textView.font else { return }
        // The caret's bounds include paragraph leading; its center is not a text baseline.
        let manager = textView.layoutManager
        manager.ensureLayout(for: textView.textContainer)
        let glyphs = manager.glyphRange(for: textView.textContainer)
        let baseline: CGFloat
        if glyphs.length > 0 {
            baseline = manager.location(forGlyphAt: glyphs.location).y
        } else {
            baseline = font.ascender + max(0, 28 - font.lineHeight)
        }
        button.layoutIfNeeded()
        guard let label = button.titleLabel, let labelFont = label.font else { return }
        let titleRect = label.textRect(forBounds: label.bounds, limitedToNumberOfLines: 1)
        let titleBaseline = label.convert(CGPoint(x: 0, y: titleRect.minY + labelFont.ascender), to: inlineTokens).y
        inlineTokens.frame.origin.y = textView.textContainerInset.top + baseline - titleBaseline
    }

    private func layoutTokenButtons() {
        var x: CGFloat = 0
        for button in tokens.subviews {
            let width = min(220, button.sizeThatFits(CGSize(width: 220, height: 28)).width)
            button.frame = CGRect(x: x, y: 2, width: width, height: 28)
            x += width + 6
        }
        tokens.contentSize = CGSize(width: x, height: 32)
    }

    private func rebuildSuggestions() {
        suggestions.subviews.compactMap { $0 as? UIButton }.forEach { $0.removeFromSuperview() }
        suggestions.contentOffset = .zero
        for item in suggestionItems {
            let button = UIButton(type: .system)
            var config = UIButton.Configuration.plain()
            config.title = item["title"] as? String
            config.subtitle = item["subtitle"] as? String
            config.titleLineBreakMode = .byTruncatingTail
            config.subtitleLineBreakMode = .byTruncatingTail
            config.titleAlignment = .leading
            config.baseForegroundColor = .label
            let type = item["type"] as? String
            config.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 12, bottom: 8, trailing: type == nil ? 12 : 96)
            button.contentHorizontalAlignment = .leading
            button.configuration = config
            button.clipsToBounds = true
            if let type {
                let badge = UILabel()
                badge.tag = 1
                badge.text = type == "skill" ? "Skill" : "Command"
                badge.font = .systemFont(ofSize: 11, weight: .medium)
                badge.textAlignment = .center
                badge.textColor = type == "skill" ? brandUIColor : .secondaryLabel
                badge.backgroundColor = type == "skill" ? brandUIColor.withAlphaComponent(0.1) : UIColor.secondaryLabel.withAlphaComponent(0.08)
                badge.layer.cornerRadius = 6
                badge.clipsToBounds = true
                button.addSubview(badge)
                button.accessibilityLabel = "\(item["title"] as? String ?? ""), \(badge.text ?? "")"
            }
            button.addAction(UIAction { [weak self] _ in
                guard let self else { return }
                self.emitAction("suggestion:\(item["id"] as? String ?? "")")
            }, for: .touchUpInside)
            suggestions.addSubview(button)
        }
    }

    private func layoutSuggestionButtons() {
        for (index, button) in suggestions.subviews.compactMap({ $0 as? UIButton }).enumerated() {
            button.frame = CGRect(x: 0, y: CGFloat(index) * 48, width: suggestions.bounds.width, height: 48)
            if let badge = button.viewWithTag(1) as? UILabel {
                let width = badge.intrinsicContentSize.width + 12
                badge.frame = CGRect(x: button.bounds.width - width - 12, y: 14, width: width, height: 20)
            }
        }
        suggestions.contentSize = CGSize(width: suggestions.bounds.width, height: CGFloat(suggestionItems.count) * 48)
    }

    func textViewDidChange(_ textView: UITextView) {
        guard !applyingText else { return }
        revision += 1
        refresh()
        scheduleChange()
    }
    func textViewDidChangeSelection(_ textView: UITextView) {
        if !applyingText { scheduleChange() }
    }
    func textViewDidBeginEditing(_ textView: UITextView) { refresh() }
    func textViewDidEndEditing(_ textView: UITextView) { flushChange(); refresh() }

    private func scheduleChange() {
        draftSync?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.flushChange() }
        draftSync = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: work)
    }

    private var snapshot: JSObject {
        ["id": owner, "text": textView.text ?? "", "revision": revision, "cursor": textView.selectedRange.location]
    }

    func flushChange() {
        draftSync?.cancel()
        guard !owner.isEmpty, textView.markedTextRange == nil else { return }
        onEvent?("change", snapshot)
    }

    @objc private func sendTapped() {
        guard send.isEnabled, textView.markedTextRange == nil else { return }
        emitSubmit(running ? "stop" : "send")
    }
    @objc private func steerTapped() {
        guard steer.isEnabled, textView.markedTextRange == nil else { return }
        emitSubmit("steer")
    }
    private func emitSubmit(_ action: String) {
        flushChange()
        var data = snapshot
        data["action"] = action
        if action == "send" { submissionPending = true; refresh() }
        onEvent?("submit", data)
    }
    private func emitAction(_ action: String) {
        flushChange()
        var data = snapshot
        data["action"] = action
        onEvent?("action", data)
    }

    @objc private func keyboardChanged(_ notification: Notification) {
        guard let parent = superview,
              let endFrame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
        let frame = parent.convert(endFrame, from: nil)
        keyboardTop = frame.minY < parent.bounds.height - parent.safeAreaInsets.bottom ? frame.minY : nil
        let duration = notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
        let curve = notification.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? UInt ?? 7
        UIView.animate(withDuration: duration, delay: 0, options: [UIView.AnimationOptions(rawValue: curve << 16), .beginFromCurrentState, .allowUserInteraction]) {
            self.refresh()
        }
    }
}

/// The composer's options button and menu icons, drawn in the tab bar's
/// family (`TabGlyph`) rather than taken from SF Symbols: 24-unit grid, y down,
/// 1.75 round strokes. Menu items name them by `symbol`; anything else falls
/// back to an SF Symbol of that name.
enum ComposerGlyph: String {
    case options, model, thinking, mode, fast, goal

    func image(size: CGFloat = 22) -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { context in
            let ctx = context.cgContext
            ctx.scaleBy(x: size / 24, y: size / 24)
            ctx.setLineWidth(1.75)
            ctx.setLineCap(.round)
            ctx.setLineJoin(.round)
            UIColor.black.setStroke()
            UIColor.black.setFill()
            let (strokes, fills) = shapes()
            ctx.addPath(strokes)
            ctx.strokePath()
            if let fills {
                ctx.addPath(fills)
                ctx.fillPath()
            }
        }.withRenderingMode(.alwaysTemplate)
    }

    /// Stroked marks, filled marks. Angles grow clockwise on screen (y down).
    private func shapes() -> (CGPath, CGPath?) {
        func radians(_ degrees: CGFloat) -> CGFloat { degrees * .pi / 180 }
        func point(_ center: CGPoint, _ radius: CGFloat, _ degrees: CGFloat) -> CGPoint {
            CGPoint(x: center.x + radius * cos(radians(degrees)), y: center.y + radius * sin(radians(degrees)))
        }
        func dot(_ center: CGPoint, _ radius: CGFloat) -> CGPath {
            CGPath(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2), transform: nil)
        }
        let path = CGMutablePath()
        switch self {
        case .options:
            // A dial open at the bottom, its needle up and to the right.
            let center = CGPoint(x: 12, y: 12.75)
            path.addArc(center: center, radius: 8.5, startAngle: radians(135), endAngle: radians(405), clockwise: false)
            path.move(to: center)
            path.addLine(to: point(center, 5.25, -50))
            return (path, dot(center, 1.9))

        case .model:
            // A cube.
            path.addLines(between: [
                CGPoint(x: 12, y: 3.25), CGPoint(x: 19.75, y: 7.6), CGPoint(x: 19.75, y: 16.4),
                CGPoint(x: 12, y: 20.75), CGPoint(x: 4.25, y: 16.4), CGPoint(x: 4.25, y: 7.6),
            ])
            path.closeSubpath()
            path.addLines(between: [CGPoint(x: 4.25, y: 7.6), CGPoint(x: 12, y: 11.95), CGPoint(x: 19.75, y: 7.6)])
            path.move(to: CGPoint(x: 12, y: 11.95))
            path.addLine(to: CGPoint(x: 12, y: 20.75))
            return (path, nil)

        case .thinking:
            // A light bulb with a glint, its base below.
            let center = CGPoint(x: 12, y: 9.75)
            path.addArc(center: center, radius: 6.5, startAngle: radians(130), endAngle: radians(410), clockwise: false)
            path.addLine(to: CGPoint(x: 14.6, y: 17))
            path.addLine(to: CGPoint(x: 9.4, y: 17))
            path.closeSubpath()
            path.move(to: CGPoint(x: 9.75, y: 20))
            path.addLine(to: CGPoint(x: 14.25, y: 20))
            path.move(to: point(center, 3.4, 195))
            path.addArc(center: center, radius: 3.4, startAngle: radians(195), endAngle: radians(262), clockwise: false)
            return (path, nil)

        case .mode:
            // A switch, knob to the right.
            path.addRoundedRect(in: CGRect(x: 2.75, y: 6.75, width: 18.5, height: 10.5), cornerWidth: 5.25, cornerHeight: 5.25)
            return (path, dot(CGPoint(x: 16, y: 12), 2.6))

        case .fast:
            // A bolt.
            path.addLines(between: [
                CGPoint(x: 13.25, y: 3), CGPoint(x: 5.5, y: 13.25), CGPoint(x: 11.5, y: 13.25),
                CGPoint(x: 10.75, y: 21), CGPoint(x: 18.5, y: 10.75), CGPoint(x: 12.5, y: 10.75),
            ])
            path.closeSubpath()
            return (path, nil)

        case .goal:
            // A target.
            let center = CGPoint(x: 12, y: 12)
            path.addPath(dot(center, 8.5))
            path.addPath(dot(center, 4.5))
            return (path, dot(center, 1.5))
        }
    }
}
