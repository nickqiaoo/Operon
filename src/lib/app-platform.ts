import { nativePlatform } from '@/lib/native'

/**
 * Which product surface this bundle is running as.
 *
 * The same web bundle ships as four different products (browser tab, installed
 * PWA, iOS app, Android app), so neither the build flags nor PostHog's own
 * `$browser` / `$os` can tell them apart: Electron reports as Chrome on macOS,
 * an installed PWA reports exactly like the tab it was installed from, and the
 * native shells report as the system web view. Every analytics event carries
 * this explicitly instead.
 */
export type AppPlatform = 'desktop' | 'web' | 'pwa' | 'ios' | 'android'

/** How the browser presents the window. Internal — only `pwa` vs `web` is reported. */
type DisplayMode = 'standalone' | 'minimal-ui' | 'fullscreen' | 'browser'

/**
 * Presentation modes that mean "installed".
 *
 * `fullscreen` is deliberately not one of them: it also matches a plain browser
 * tab the user pressed F11 in. Our manifest declares `display: 'standalone'`,
 * so an installed client never presents as fullscreen on its own, and nothing
 * in the app calls `requestFullscreen`.
 */
const INSTALLED_DISPLAY_MODES = ['standalone', 'minimal-ui'] as const
const DETECTED_DISPLAY_MODES = [...INSTALLED_DISPLAY_MODES, 'fullscreen'] as const

function matches(query: string): boolean {
  try {
    return window.matchMedia(query).matches
  } catch {
    // Headless/test environments have no matchMedia; treat it as "not matching"
    // rather than letting analytics setup throw.
    return false
  }
}

export function windowDisplayMode(): DisplayMode {
  for (const mode of DETECTED_DISPLAY_MODES) {
    if (matches(`(display-mode: ${mode})`)) return mode
  }
  // iOS Safari predates the display-mode media query for home-screen apps and
  // signals an installed PWA through this non-standard flag instead.
  const legacy = globalThis.navigator as (Navigator & { standalone?: boolean }) | undefined
  if (legacy?.standalone === true) return 'standalone'
  return 'browser'
}

export interface AppPlatformInput {
  /** Build target: the Electron desktop shell vs the web bundle. */
  target: 'electron' | 'web'
  /** Capacitor shell, or `web` when not packaged in one. */
  native: 'ios' | 'android' | 'web'
  displayMode: DisplayMode
}

/**
 * Pure so every branch is testable: the build target is a compile-time constant
 * that a test cannot vary.
 */
export function resolveAppPlatform(input: AppPlatformInput): AppPlatform {
  if (input.target === 'electron') return 'desktop'
  // The native shells render inside a web view whose display mode is
  // meaningless — there is no browser chrome to have or lack.
  if (input.native !== 'web') return input.native
  return (INSTALLED_DISPLAY_MODES as readonly string[]).includes(input.displayMode) ? 'pwa' : 'web'
}

export function appPlatform(): AppPlatform {
  return resolveAppPlatform({
    target: __APP_TARGET__,
    native: nativePlatform(),
    displayMode: windowDisplayMode(),
  })
}

/** Kept in sync with `useIsMobile` — the shell branch in `Root.tsx` uses that hook. */
const MOBILE_QUERY = '(max-width: 768px)'

/**
 * Which shell is rendering: the multi-pane `App` or the bottom-tab `MobileApp`.
 * Mirrors the branch in `Root.tsx` exactly.
 *
 * This is what analytics screen URLs are namespaced by, because it is what
 * decides the layout — heatmaps and click coordinates from the two shells are
 * not comparable and must not land on the same URL.
 */
export function appShell(): 'desktop' | 'mobile' {
  return __APP_TARGET__ === 'web' && matches(MOBILE_QUERY) ? 'mobile' : 'desktop'
}
