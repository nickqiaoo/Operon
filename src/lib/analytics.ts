import { App as CapacitorApp } from '@capacitor/app'
import posthog, { type CaptureResult, type Properties } from 'posthog-js'
import { appPlatform, appShell, type AppPlatform } from '@/lib/app-platform'

const POSTHOG_KEY = 'phc_p9nI7Xag0whG3IcBUeO19m9FmCObKzJUDsz1jGcKep'
const POSTHOG_HOST = 'https://us.i.posthog.com'
const APP_ANALYTICS_URL = 'app://operon'
const URL_PROPERTY_KEYS = [
  '$current_url',
  '$referrer',
  '$initial_current_url',
  '$initial_referrer',
] as const
/**
 * `$pathname` is `location.pathname`, which the URL keys above never covered.
 * On the packaged desktop app that is the on-disk path of the bundle, so it
 * leaked wherever the user installed or checked out the app.
 */
const PATH_PROPERTY_KEYS = ['$pathname', '$initial_pathname'] as const

/**
 * Opt-out flag, in localStorage so it survives a reload and is readable before
 * PostHog itself has loaded.
 *
 * The privacy policy promises analytics can be turned off, and for a long time
 * nothing implemented that promise: the only `opt_out_capturing()` call was
 * gated on `import.meta.env.DEV`. Read this before init rather than opting out
 * afterwards, so a user who has opted out never has a session started for them
 * at all.
 */
const OPT_OUT_KEY = 'operon.analytics.optOut'

export function isAnalyticsOptedOut(): boolean {
  try {
    return localStorage.getItem(OPT_OUT_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Turn analytics on or off. Opting out also clears the identifiers PostHog has
 * already stored, so the next opt-in starts from a new anonymous id rather than
 * resuming the old one.
 */
export function setAnalyticsOptedOut(optedOut: boolean): void {
  try {
    if (optedOut) localStorage.setItem(OPT_OUT_KEY, '1')
    else localStorage.removeItem(OPT_OUT_KEY)
  } catch {
    // A browser refusing storage just means the choice does not persist.
  }
  if (!initialized) {
    if (optedOut) reportAnalyticsStateToMain()
    else initAnalytics()
    return
  }
  if (optedOut) {
    posthog.opt_out_capturing()
    posthog.reset()
    // reset() drops the identity too; leaving the record behind would make the
    // next opt-in skip re-identifying the same account as already bound.
    writeIdentifiedUserId(null)
    reportAnalyticsStateToMain()
  } else {
    reconcileAnalyticsConsent()
    reportAnalyticsStateToMain()
  }
}

/**
 * Tell the Electron main process whether to send its own events, and under
 * which identity.
 *
 * The main process cannot read either fact for itself: consent lives in this
 * renderer's localStorage and the distinct id is PostHog's. Until it hears
 * from us it buffers rather than sends, so this must be called on every change
 * — opting out, opting back in, and after `identify()` mints a new id.
 */
function reportAnalyticsStateToMain(): void {
  const sync = window.electronAPI?.syncAnalyticsId
  if (!sync) return

  const optedOut = isAnalyticsOptedOut()
  // No id to hand over when opted out — nothing may be sent under it anyway.
  const distinctId = optedOut || !initialized ? '' : posthog.get_distinct_id()
  void sync(distinctId ?? '', optedOut)
}

let initialized = false
let lastActivePageviewDay = ''

function currentUtcDay(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Pageview URLs must never include OAuth codes, tokens, search text, or other
 * query data. Native shells use a stable app URL; web builds retain only their
 * origin and pathname so screen-level analytics remain useful.
 */
export function sanitizeAnalyticsUrl(value: unknown): unknown {
  if (typeof value !== 'string') return value

  try {
    const url = new URL(value)
    if (
      url.protocol === 'file:'
      || url.protocol === 'capacitor:'
      || url.protocol === 'ionic:'
      || url.protocol === 'app:'
    ) {
      return APP_ANALYTICS_URL
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return url.protocol
    return `${url.origin}${url.pathname}`
  } catch {
    return value.split(/[?#]/, 1)[0]
  }
}

export function sanitizeAnalyticsProperties(properties: Properties): Properties {
  for (const key of URL_PROPERTY_KEYS) {
    if (key in properties) properties[key] = sanitizeAnalyticsUrl(properties[key])
  }
  for (const key of PATH_PROPERTY_KEYS) {
    if (key in properties) properties[key] = currentScreenPath()
  }
  // The real URL identifies the build, not the screen: this app has no router,
  // so `location` never changes and every event would otherwise land on one
  // undifferentiated URL. Substituting the logical screen is what makes paths,
  // heatmaps and dead clicks resolve to something.
  if ('$current_url' in properties) properties.$current_url = currentScreenUrl()
  return properties
}

let currentScreen = 'home'

/**
 * The screen the user is on, as a path.
 *
 * Namespaced by shell because the desktop and mobile layouts are different
 * products sharing a bundle — pooling their click coordinates on one URL would
 * make every heatmap unreadable.
 */
function currentScreenPath(): string {
  return `/${appShell()}/${currentScreen}`
}

function currentScreenUrl(): string {
  return `${APP_ANALYTICS_URL}${currentScreenPath()}`
}

/**
 * Record which screen the user moved to, and emit the `$pageview` that PostHog
 * cannot emit for itself.
 *
 * `capture_pageview: 'history_change'` never fires after the first event: the
 * app navigates by React state, not by history, so pageviews only ever marked
 * app starts. Screen changes are the real navigation and this is where they
 * become visible.
 */
export function setAnalyticsScreen(screen: string): void {
  if (screen === currentScreen) return
  currentScreen = screen
  if (!initialized) return

  lastActivePageviewDay = currentUtcDay()
  posthog.capture('$pageview')
}

/**
 * Cached because `before_send` runs on every single event, including
 * autocapture and web vitals. Invalidated by {@link installPlatformTracking}.
 * Computed lazily so importing this module has no side effects.
 */
let cachedPlatform: AppPlatform | null = null

/**
 * The surface identity attached to every event.
 *
 * Desktop, browser, installed PWA, iOS and Android are otherwise
 * indistinguishable in PostHog: the same web bundle ships as four of them, and
 * Electron reports itself as plain Chrome. Injecting here rather than through
 * `register()` covers the events we never construct ourselves — `$pageview`,
 * autocapture, web vitals, exceptions — including the initial pageview PostHog
 * emits from inside `init`, and keeps nothing stale in localStorage.
 */
function currentPlatform(): AppPlatform {
  cachedPlatform ??= appPlatform()
  return cachedPlatform
}

export function sanitizeAnalyticsEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event) return null
  event.properties = sanitizeAnalyticsProperties(event.properties)
  event.properties = { app_platform: currentPlatform(), ...event.properties }
  return event
}

/**
 * Our own opt-out flag is the source of truth. Older builds could remove that
 * flag without clearing PostHog's separate consent value, leaving the SDK
 * initialized but silently dropping every event.
 */
function reconcileAnalyticsConsent(): void {
  if (!initialized || !posthog.has_opted_out_capturing()) return

  posthog.opt_in_capturing({ captureEventName: false })
  lastActivePageviewDay = currentUtcDay()
}

/**
 * Electron and installed PWAs can remain open across multiple days without a
 * reload. Route pageviews do not cover a new day when the app remains on the
 * same screen, so emit a standard pageview on the first visible activity of
 * each UTC day. The event carries no input or pointer data; those events are
 * only activity signals.
 */
function captureDailyActivePageview(): void {
  if (!initialized || document.visibilityState === 'hidden') return

  const day = currentUtcDay()
  if (day === lastActivePageviewDay) return

  lastActivePageviewDay = day
  posthog.capture('$pageview')
}

/**
 * The surface can change inside a session: a browser tab can be installed to
 * the home screen and reopened standalone. Recompute on that transition so
 * events are not filed under the surface the session started in.
 */
function installPlatformTracking(): void {
  const queries = ['(display-mode: standalone)', '(display-mode: minimal-ui)']
  const refresh = () => { cachedPlatform = null }
  for (const query of queries) {
    try {
      window.matchMedia(query).addEventListener('change', refresh)
    } catch {
      // No matchMedia (headless): the values computed at module load stand.
    }
  }
}

function installActivePageviewTracking(): void {
  window.addEventListener('focus', captureDailyActivePageview)
  window.addEventListener('pointerdown', captureDailyActivePageview, { capture: true, passive: true })
  window.addEventListener('keydown', captureDailyActivePageview, { capture: true })
  document.addEventListener('visibilitychange', captureDailyActivePageview)

  if (__APP_NATIVE__) {
    void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) captureDailyActivePageview()
    }).catch(() => {
      // Window visibility and focus events remain as the cross-platform fallback.
    })
  }
}

export function initAnalytics() {
  if (initialized) return
  if (isAnalyticsOptedOut()) {
    // Still report: the main process is holding its own events until it hears
    // whether it may send them, and the answer here is no.
    reportAnalyticsStateToMain()
    return
  }

  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    autocapture: {
      dom_event_allowlist: ['click', 'change', 'submit'],
      capture_copied_text: false,
    },
    capture_pageview: 'history_change',
    capture_pageleave: true,
    // Off: the heuristic ("no DOM mutation, scroll, selection or navigation
    // within ~2.5s of a click") does not survive this app's surfaces. Every
    // click inside a browser `<webview>` lands in a guest document the host
    // never sees mutate, the terminal paints to a canvas rather than the DOM,
    // and desktop users click chrome and drag regions constantly just to focus
    // the window — all reported dead. The few real ones (an action that renders
    // nothing for 2.5s) are indistinguishable from that noise, and `mask_all_*`
    // strips the text and attributes that would have told them apart.
    //
    // `rageclick` covers the same question better: repeated clicks on one spot
    // are a deliberate signal, not an inference from absence.
    capture_dead_clicks: false,
    rageclick: true,
    capture_heatmaps: true,
    capture_performance: {
      network_timing: false,
      web_vitals: true,
      web_vitals_attribution: false,
    },
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
    disable_session_recording: true,
    enable_recording_console_log: false,
    logs: { captureConsoleLogs: false },
    disable_surveys: true,
    disable_product_tours: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    mask_personal_data_properties: true,
    save_campaign_params: false,
    save_referrer: false,
    persistence: 'localStorage',
    before_send: sanitizeAnalyticsEvent,
    loaded: (ph) => {
      if (import.meta.env.DEV) {
        ph.opt_out_capturing()
      }
    },
  })

  initialized = true
  // Releases the main process's buffered events under the real distinct id.
  reportAnalyticsStateToMain()
  lastActivePageviewDay = currentUtcDay()
  installPlatformTracking()
  installActivePageviewTracking()

  if (!import.meta.env.DEV) reconcileAnalyticsConsent()
}

export function trackError(error: Error, context?: Record<string, unknown>) {
  if (!initialized) return
  posthog.capture('app_crash', {
    process: 'renderer',
    type: 'component_error',
    message: error.message,
    stack: error.stack,
    ...context,
  })
}

export function trackEvent(event: string, properties?: Record<string, unknown>) {
  if (!initialized) return
  posthog.capture(event, properties)
}

/**
 * The broker user id we last told PostHog about.
 *
 * Persisted rather than held in a module variable because sign-out reloads the
 * page: PostHog keeps the distinct id in its own storage, so a fresh module
 * with `null` here would compare `null === null`, skip the reset, and leave the
 * app reporting as the account that just signed out.
 */
const IDENTIFIED_KEY = 'operon.analytics.identifiedUserId'

function readIdentifiedUserId(): string | null {
  try {
    return localStorage.getItem(IDENTIFIED_KEY)
  } catch {
    return null
  }
}

function writeIdentifiedUserId(userId: string | null): void {
  try {
    if (userId) localStorage.setItem(IDENTIFIED_KEY, userId)
    else localStorage.removeItem(IDENTIFIED_KEY)
  } catch {
    // Storage refused: identity still applies to this session, it just will not
    // survive a reload.
  }
}

/**
 * Bind events to the signed-in broker account, or unbind on sign-out.
 *
 * Without this every client is an anonymous device: the same person on desktop,
 * the web, an installed PWA and the phone app counts as four separate users
 * that can never be reconciled, which makes the `app_platform` split unusable
 * for the question it exists to answer ("do people use more than one?").
 *
 * The id is the broker JWT's `sub` on both sides — read from the token on the
 * web clients, and reported by `/saas/status` on desktop, where the token lives
 * server-side — so the same account lines up across all five surfaces.
 *
 * Pass `null` on sign-out: PostHog persists the distinct id, so without a reset
 * the next person to use this machine inherits the previous account's identity.
 */
export function syncAnalyticsIdentity(userId: string | null): void {
  if (!initialized) return
  if (userId === readIdentifiedUserId()) return

  if (userId) posthog.identify(userId, { app_platform: currentPlatform() })
  else posthog.reset()

  writeIdentifiedUserId(userId)
  // identify() and reset() both mint a new distinct id; the main process is
  // still holding the old one.
  reportAnalyticsStateToMain()
}

export { posthog }
