import AppKit
import ApplicationServices
import Foundation

/// Codex `UIElementProtocol.clickingMayCauseSelection`.
///
/// True when a left-click is likely to place a caret or change text selection
/// rather than only fire a button-style action.
func clickingMayCauseSelection(element: AXUIElement) -> Bool {
    var roleRef: CFTypeRef?
    AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef)
    let role = roleRef as? String ?? ""

    if role == kAXTextFieldRole as String
        || role == "AXTextArea"
        || role == "AXTextView"
        || role == kAXComboBoxRole as String
        || role == "AXSearchField"
    {
        return true
    }

    var settable = DarwinBoolean(false)
    if AXUIElementIsAttributeSettable(
        element,
        kAXSelectedTextRangeAttribute as CFString,
        &settable
    ) == .success, settable.boolValue {
        return true
    }

    var roleDescRef: CFTypeRef?
    AXUIElementCopyAttributeValue(
        element,
        kAXRoleDescriptionAttribute as CFString,
        &roleDescRef
    )
    let desc = (roleDescRef as? String ?? "").lowercased()
    if desc.contains("text field")
        || desc.contains("text area")
        || desc.contains("search")
        || desc.contains("editor")
        || desc.contains("text entry")
    {
        return true
    }

    return false
}

/// Codex `ApplicationUIElement.isCatalystApp`.
func isCatalystApp(
    bundleIdentifier: String?,
    appPath: String?
) -> Bool {
    let bid = (bundleIdentifier ?? "").lowercased()
    if bid.contains("catalyst") || bid.hasPrefix("com.apple.dt.") {
        // Not all Apple apps are Catalyst; fall through to Info.plist.
    }

    let pathCandidates: [String] = {
        var paths: [String] = []
        if let appPath, !appPath.isEmpty {
            paths.append(appPath)
        }
        if let bid = bundleIdentifier,
           let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bid)
        {
            paths.append(url.path)
        }
        return paths
    }()

    for path in pathCandidates {
        let infoPath = (path as NSString).appendingPathComponent("Contents/Info.plist")
        guard let info = NSDictionary(contentsOfFile: infoPath) as? [String: Any] else {
            continue
        }
        if info["LSRequiresIPhoneOS"] as? Bool == true {
            return true
        }
        if let families = info["UIDeviceFamily"] as? [Any], !families.isEmpty {
            return true
        }
        // Embedded iOS binary layout
        let wrapper = (path as NSString).appendingPathComponent("Wrappers")
        if FileManager.default.fileExists(atPath: wrapper) {
            return true
        }
    }

    // Heuristic: bundle id pattern used by some Catalyst ports
    if bid.contains(".ipados.") || bid.hasSuffix(".catalyst") {
        return true
    }
    return false
}

/// Whether `candidate` is the app's current AX focused window.
func targetWindowIsFocusedWindow(
    appPID: pid_t,
    candidate: AXUIElement?
) -> Bool? {
    guard let candidate else {
        return nil
    }
    let app = AXUIElementCreateApplication(appPID)
    var focused: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        app,
        kAXFocusedWindowAttribute as CFString,
        &focused
    ) == .success,
    let focused,
    CFGetTypeID(focused) == AXUIElementGetTypeID()
    else {
        return false
    }
    return CFEqual(candidate, focused as! AXUIElement)
}
