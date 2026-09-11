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

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

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

// ---- native shell (iOS system tab bar) ----

/**
 * Thin bridge to `NativeShellPlugin.swift` (iOS only).
 *
 * On iOS the bottom tab bar is the system `UITabBarController` bar (Liquid
 * Glass on iOS 26) drawn over the web view; the web app stays the source of
 * truth for which tab is active and just mirrors it over this plugin. Titles
 * are sent from JS so they follow the app's locale. `tabBarInset` is how much
 * of the web view's bottom the bar covers, which the shell pads its content by.
 */
export interface NativeShellPlugin {
  configure(options: { tabs: { id: string; title: string }[] }): Promise<{ tabBarInset: number }>
  selectTab(options: { tab: string }): Promise<void>
  setTabBarVisible(options: { visible: boolean }): Promise<void>
  /**
   * The navigation bar. `context` = project › workspace title + inbox bell
   * (list screens), `back` = a lone back button (open conversation), `hidden`.
   */
  setTopBar(options: {
    mode: NativeTopBarMode
    title: string
    subtitle?: string
    unread: boolean
    /** False while a web overlay is up: the bar stays put but stops taking taps. */
    interactive: boolean
  }): Promise<void>
  addListener(eventName: 'tabSelected', listener: (event: { tab: string }) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'layout', listener: (event: { tabBarInset: number }) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'topBarAction', listener: (event: { action: NativeTopBarAction }) => void): Promise<PluginListenerHandle>
  /**
   * Project → workspace picker as a system sheet. Resolves once the sheet is
   * up; the pick arrives as `contextPicked`, every dismissal as
   * `contextSheetDismissed`.
   */
  presentContextSheet(options: {
    title: string
    emptyText: string
    projects: { id: number; name: string; workspaces: { id: number; name: string }[] }[]
    activeProjectId?: number
    activeWorkspaceId?: number
  }): Promise<void>
  addListener(
    eventName: 'contextPicked',
    listener: (event: { projectId: number; workspaceId?: number }) => void,
  ): Promise<PluginListenerHandle>
  addListener(eventName: 'contextSheetDismissed', listener: () => void): Promise<PluginListenerHandle>
  /**
   * "New chat" agent picker as a system sheet. The pick arrives as
   * `agentPicked { id }`; `logo` is an imageset name in the iOS asset catalog
   * (see `providerLogoName`).
   */
  presentAgentSheet(options: {
    title: string
    emptyText: string
    agents: { id: string; label: string; logo?: string }[]
  }): Promise<void>
  addListener(eventName: 'agentPicked', listener: (event: { id: string }) => void): Promise<PluginListenerHandle>
  /** Model picker as a system sheet; the pick arrives as `modelPicked { id }`. */
  presentModelSheet(options: {
    title: string
    searchPlaceholder: string
    emptyText: string
    selectedId?: string
    models: { id: string; label: string; group: string; logo?: string }[]
  }): Promise<void>
  addListener(eventName: 'modelPicked', listener: (event: { id: string }) => void): Promise<PluginListenerHandle>
  /** Read-only stats (context window, subscription quotas) as a system sheet. */
  presentInfoSheet(options: { title: string; caption?: string; sections: NativeInfoSection[] }): Promise<void>
  /**
   * Live inbox as a system sheet. Controls come back as `inboxAction`; keep
   * it current with `updateInboxSheet` until `inboxSheetDismissed`.
   */
  presentInboxSheet(options: { labels: NativeInboxLabels; state: NativeInboxState }): Promise<void>
  updateInboxSheet(options: { state: NativeInboxState }): Promise<void>
  dismissInboxSheet(): Promise<void>
  addListener(
    eventName: 'inboxAction',
    listener: (event: { action: 'open' | 'archive' | 'markAllRead' | 'filter' | 'loadMore'; id?: number; filter?: string }) => void,
  ): Promise<PluginListenerHandle>
  addListener(eventName: 'inboxSheetDismissed', listener: () => void): Promise<PluginListenerHandle>
  /** System alert with one text field. `value` is null on cancel or empty input. */
  promptText(options: {
    title: string
    message?: string
    placeholder: string
    confirmLabel: string
    cancelLabel: string
  }): Promise<{ value: string | null }>
  /** Light / dark for the native bars and sheets, following the app theme, not the OS. */
  setAppearance(options: { dark: boolean }): Promise<void>
}

export interface NativeInfoSection {
  header?: string
  value?: string
  /** 0…1 */
  progress?: number
  tone?: 'normal' | 'warn' | 'error'
  footer?: string
  rows?: { label: string; value?: string; detail?: string; color?: string; indent?: boolean }[]
}

export interface NativeInboxLabels {
  title: string
  filters: { id: string; label: string }[]
  markAllRead: string
  empty: string
  loading: string
  loadMore: string
}

export interface NativeInboxState {
  filter: string
  items: { id: number; title: string; body?: string; time: string; symbol: string; action: boolean; unread: boolean }[]
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  unreadCount: number
}

export type NativeTopBarMode = 'hidden' | 'context' | 'back'
export type NativeTopBarAction = 'context' | 'inbox' | 'back'

export const NativeShell = registerPlugin<NativeShellPlugin>('NativeShell')

/** True when the packaged app draws the tab bar and top bar natively (iOS). */
export function hasNativeTabBar(): boolean {
  return isNativeApp() && nativePlatform() === 'ios' && Capacitor.isPluginAvailable('NativeShell')
}
