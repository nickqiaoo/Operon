import Foundation
import Capacitor
import AuthenticationServices

/// OAuth in a system browser, exposed to JS as `WebAuth`.
///
/// This replaces `Browser.open` (`SFSafariViewController`) for the sign-in
/// round-trip, for one reason: `SFSafariViewController` will not hand a
/// *server-side redirect* to a custom scheme back to the app. The broker's
/// GitHub callback ends in a 302 to `operon://auth/callback`, and inside a
/// Safari sheet that redirect goes nowhere — no `appUrlOpen`, no error, the
/// sheet simply sits there until the user dismisses it and lands back on the
/// login screen with nothing having happened. (Typing the same URL by hand does
/// open the app, which is what isolates this to the redirect path.)
///
/// `ASWebAuthenticationSession` is Apple's answer for exactly this: it takes the
/// callback scheme as a parameter, intercepts the redirect itself, and returns
/// the URL straight to the caller. So the completion handler *is* the delivery
/// mechanism — no deep-link listener involved on iOS.
///
/// Not ephemeral on purpose: sharing Safari's cookie jar means an already
/// signed-in GitHub user just taps through. The price is the one-time system
/// consent sheet ("… wants to use github.com to sign in"), which is the
/// standard, expected iOS OAuth flow.
///
/// See `src/lib/native.ts` for the JS side.
@objc(WebAuthPlugin)
public class WebAuthPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "WebAuthPlugin"
    public let jsName = "WebAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise)
    ]

    /// Held for the lifetime of the flow — ASWebAuthenticationSession is
    /// deallocated (and the sheet dismissed) the moment nothing retains it.
    private var session: ASWebAuthenticationSession?

    @objc func authenticate(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("url is required")
            return
        }
        guard let callbackScheme = call.getString("callbackScheme"), !callbackScheme.isEmpty else {
            call.reject("callbackScheme is required")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: callbackScheme
            ) { [weak self] callbackURL, error in
                self?.session = nil

                if let error = error {
                    let nsError = error as NSError
                    // Dismissing the sheet is a normal outcome, not a failure —
                    // the caller shows no error toast for it.
                    if nsError.domain == ASWebAuthenticationSessionErrorDomain,
                       nsError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        call.resolve(["cancelled": true])
                        return
                    }
                    call.reject(error.localizedDescription)
                    return
                }

                guard let callbackURL = callbackURL else {
                    call.reject("the authentication session returned no URL")
                    return
                }
                call.resolve(["url": callbackURL.absoluteString])
            }

            session.presentationContextProvider = self
            self.session = session

            if !session.start() {
                self.session = nil
                call.reject("could not start the authentication session")
            }
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        // The web view's own window. Falling back to a bare anchor keeps this
        // non-optional contract satisfiable, though in practice the bridge is
        // always attached by the time JS can call in.
        return bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
}
