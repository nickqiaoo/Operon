import UIKit
import Capacitor
import WebKit

/// Registers plugins implemented directly in the app target. Capacitor only
/// auto-registers plugins declared by packages in capacitor.config.json.
class BridgeViewController: CAPBridgeViewController {
    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        ShellWebView(frame: frame, configuration: configuration)
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(SecureStoragePlugin())
        bridge?.registerPluginInstance(WebAuthPlugin())
        bridge?.registerPluginInstance(NativeShellPlugin())
        bridge?.registerPluginInstance(NativeComposerPlugin())
    }
}

/// The web view always fills its container; the page lays out its own safe
/// areas (`viewport-fit=cover`, `env(safe-area-inset-*)`).
///
/// The StatusBar plugin re-frames the web view after every size transition and,
/// even in overlay mode, shifts it down by `statusBarFrame.height -
/// safeAreaInsets.top`. In an iPadOS window that is the screen's status bar
/// (32pt) minus the window's top inset (10pt): the page slid down 22pt and the
/// web view's dark background showed through as a band above it. Full screen
/// and iPhone both come out at 0, which is why only resizing showed it. Nothing
/// else in the app moves the web view (the Keyboard plugin runs with
/// `resize: none`), so any frame other than the container's bounds is that.
final class ShellWebView: WKWebView {
    override var frame: CGRect {
        get { super.frame }
        set { super.frame = superview?.bounds ?? newValue }
    }
}

@main
class AppDelegate: UIResponder, UIApplicationDelegate {

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        return true
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }

    // APNs hands the device token to the app delegate, but the JS side listens
    // on Capacitor's notification center. Without these two bridges the
    // PushNotifications plugin's `registration` event never fires and the app
    // silently never registers for push.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

}
