import type { CapacitorConfig } from '@capacitor/cli'
import { KeyboardResize } from '@capacitor/keyboard'

/**
 * Native iOS shell around the same `dist-web` bundle the browser client ships.
 * There is no third build target: the native app IS the web client
 * (`__APP_TARGET__ === 'web'`), packaged locally and pointed at the same broker.
 * Only the handful of places that need a native API branch on `isNativeApp()`.
 *
 * `iosScheme: 'https'` DOES NOT DO WHAT IT LOOKS LIKE. WKWebView will not let a
 * scheme handler be registered for http/https (WebKit handles them internally),
 * so Capacitor silently ignores the value and serves the app from
 * `capacitor://localhost` regardless. Verified on device: every request the app
 * makes carries `Origin: capacitor://localhost`.
 *
 * It is kept only because removing it would change nothing, while *changing* the
 * scheme to something the platform accepts would strand the localStorage of
 * everyone who already installed the app (web storage is keyed by origin).
 *
 * Consequences, both of which are handled elsewhere rather than here:
 *
 *   1. The broker must allow `capacitor://localhost` explicitly — see
 *      `nativeAppOrigin` in broker/main.go. Before it did, every API call the
 *      app made was answered 403 "origin not allowed" by the CORS middleware,
 *      which logs nothing, so sign-in just bounced back to the login screen.
 *   2. PKCE needs `crypto.subtle`, which requires a secure context. A Capacitor
 *      custom scheme qualifies on iOS, so this works — but it works *because of
 *      the custom scheme*, not because of the `https` written above.
 *
 * Android genuinely is `https://localhost`: `androidScheme` defaults to https
 * and, unlike iOS, that one takes effect.
 */
const config: CapacitorConfig = {
  appId: 'top.chatcode.operon.app',
  appName: 'Operon',
  webDir: 'dist-web',
  server: {
    iosScheme: 'https',
    hostname: 'localhost',
  },
  ios: {
    // The web layer already draws its own safe-area padding via
    // `env(safe-area-inset-*)` and `viewport-fit=cover`. Letting UIKit also
    // inset the web view would apply the inset twice.
    contentInset: 'never',
    // Kills the rubber-band bounce of the *root* web view. Inner scrollers
    // (transcript, lists) are unaffected — they're regular DOM overflow.
    scrollEnabled: false,
    backgroundColor: '#0b0b0d',
  },
  android: {
    backgroundColor: '#0b0b0d',
  },
  plugins: {
    Keyboard: {
      // 'none' = don't let the OS resize the web view. The mobile shell already
      // positions the composer itself from the reported keyboard height
      // (`--keyboard-height`); letting UIKit also resize would move it twice.
      resize: KeyboardResize.None,
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
}

export default config
