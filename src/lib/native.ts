// Native (Capacitor / iOS) runtime bridge.
//
// The iOS app ships the *same* bundle as the browser client — `__APP_TARGET__`
// is still 'web', it still talks to the broker, it still renders MobileApp.
// This module is the whole seam: the few things a packaged app can do that a
// browser tab cannot (keychain, system keyboard metrics, APNs, opening an
// auth session) live behind these helpers, and every caller gates on
// `isNativeApp()`.
//
// `__APP_NATIVE__` is a compile-time constant, so in the browser build every
// one of these branches folds to `false` and the bodies are dropped.

import { Capacitor, registerPlugin } from '@capacitor/core'

/** True only inside a packaged app (iOS or Android). */
export function isNativeApp(): boolean {
  return __APP_NATIVE__ && Capacitor.isNativePlatform()
}

/**
 * Which shell we're in. Most native code is platform-agnostic and should test
 * `isNativeApp()` instead — reach for this only where the platforms genuinely
 * differ (keyboard handling, status bar background, push token platform).
 */
export function nativePlatform(): 'ios' | 'android' | 'web' {
  if (!__APP_NATIVE__) return 'web'
  const platform = Capacitor.getPlatform()
  return platform === 'ios' || platform === 'android' ? platform : 'web'
}

/** The custom URL scheme the app registers, used for the OAuth callback. */
export const NATIVE_URL_SCHEME = 'operon'

/** Where the broker sends the browser back to after a native sign-in. */
export const NATIVE_REDIRECT_URI = `${NATIVE_URL_SCHEME}://auth/callback`

// ---- keychain ----

/**
 * Thin bridge to `SecureStoragePlugin.swift` in the iOS target.
 *
 * Deliberately hand-rolled instead of pulling in a community secure-storage
 * package: the surface is three methods over the iOS keychain, and a login
 * credential is the last place to take on an unaudited transitive dependency.
 *
 * Long-lived refresh credentials and remote E2EE private keys live here rather
 * than in localStorage, which is readable by any script that runs in the web view.
 */
export interface SecureStoragePlugin {
  get(options: { key: string }): Promise<{ value: string | null }>
  set(options: { key: string; value: string }): Promise<void>
  remove(options: { key: string }): Promise<void>
}

const SecureStorage = registerPlugin<SecureStoragePlugin>('SecureStorage')

export async function secureGet(key: string): Promise<string | null> {
  if (!isNativeApp()) return null
  try {
    const { value } = await SecureStorage.get({ key })
    return value ?? null
  } catch {
    // A keychain miss must read as "signed out", never as a hard failure that
    // wedges the boot gate.
    return null
  }
}

export async function secureSet(key: string, value: string): Promise<void> {
  if (!isNativeApp()) return
  try {
    await SecureStorage.set({ key, value })
  } catch {
    // Losing the refresh token only costs the user a re-login later; failing
    // the sign-in that just succeeded would be worse.
  }
}

export async function secureRemove(key: string): Promise<void> {
  if (!isNativeApp()) return
  try {
    await SecureStorage.remove({ key })
  } catch {}
}

// ---- system auth session ----

/**
 * Thin bridge to `WebAuthPlugin.swift` (iOS only).
 *
 * `authenticate` opens an `ASWebAuthenticationSession` and resolves with the
 * callback URL it intercepted — the redirect never reaches the app as a deep
 * link, so on iOS there is nothing for an `appUrlOpen` listener to catch.
 *
 * `{ cancelled: true }` means the user dismissed the sheet: an outcome, not a
 * failure, and callers must not surface it as an error.
 */
export interface WebAuthPlugin {
  authenticate(options: { url: string; callbackScheme: string }): Promise<{ url?: string; cancelled?: boolean }>
}

const WebAuth = registerPlugin<WebAuthPlugin>('WebAuth')

export type NativeAuthResult =
  | { kind: 'url'; url: string }
  | { kind: 'cancelled' }
  /** No native session available — the caller falls back to the browser sheet. */
  | { kind: 'unavailable' }

/**
 * Run the OAuth round-trip in a system auth session.
 *
 * iOS only, and `unavailable` is a normal answer everywhere else: Android has
 * no such plugin registered, and it does not need one — Chrome Custom Tabs hand
 * a redirect to a custom scheme back to the app, which is exactly what
 * `SFSafariViewController` refuses to do. So Android keeps the
 * `Browser.open` + `appUrlOpen` path.
 */
export async function nativeAuthenticate(url: string, callbackScheme: string): Promise<NativeAuthResult> {
  if (!isNativeApp() || nativePlatform() !== 'ios') return { kind: 'unavailable' }
  try {
    const result = await WebAuth.authenticate({ url, callbackScheme })
    if (result.cancelled) return { kind: 'cancelled' }
    if (result.url) return { kind: 'url', url: result.url }
    return { kind: 'unavailable' }
  } catch {
    // An older build of the shell without the plugin would reject here. Falling
    // back keeps the JS bundle forward- and backward-compatible with the native
    // side, which ships on a different cadence (App Store review).
    return { kind: 'unavailable' }
  }
}
