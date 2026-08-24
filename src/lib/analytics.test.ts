import { beforeEach, describe, expect, it, vi } from 'vitest'

const posthogMock = vi.hoisted(() => ({
  init: vi.fn((_token: string, _config: Record<string, unknown>): void => {}),
  capture: vi.fn((_event: string, _properties?: Record<string, unknown>): void => {}),
  identify: vi.fn((_userId: string, _traits?: Record<string, unknown>): void => {}),
  reset: vi.fn((): void => {}),
  opt_in_capturing: vi.fn((): void => {}),
  opt_out_capturing: vi.fn((): void => {}),
  has_opted_out_capturing: vi.fn(() => false),
  get_distinct_id: vi.fn(() => 'test-distinct-id'),
}))

vi.mock('posthog-js', () => ({ default: posthogMock }))

function createStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  }
}

interface TestDocument extends EventTarget {
  visibilityState: 'hidden' | 'visible'
}

function installBrowserGlobals(): { documentTarget: TestDocument; windowTarget: EventTarget } {
  const documentTarget = new EventTarget() as TestDocument
  documentTarget.visibilityState = 'visible'
  const windowTarget = new EventTarget()

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: documentTarget,
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: windowTarget,
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: createStorage(),
  })

  return { documentTarget, windowTarget }
}

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  for (const mock of Object.values(posthogMock)) mock.mockClear()
  posthogMock.has_opted_out_capturing.mockReturnValue(false)
  installBrowserGlobals()
})

describe('analytics privacy', () => {
  it('removes query parameters and fragments from web URLs', async () => {
    const { sanitizeAnalyticsUrl } = await import('./analytics')

    expect(sanitizeAnalyticsUrl('https://app.example/auth/callback?code=secret#done'))
      .toBe('https://app.example/auth/callback')
    expect(sanitizeAnalyticsUrl('https://referrer.example/path?q=private'))
      .toBe('https://referrer.example/path')
  })

  it('uses one stable identifier for native app URLs', async () => {
    const { sanitizeAnalyticsUrl } = await import('./analytics')

    expect(sanitizeAnalyticsUrl('file:///Users/example/private/project/index.html?token=secret'))
      .toBe('app://operon')
    expect(sanitizeAnalyticsUrl('capacitor://localhost/auth/callback?code=secret'))
      .toBe('app://operon')
    expect(sanitizeAnalyticsUrl('app://operon')).toBe('app://operon')
  })

  it('sanitizes every URL property PostHog can persist', async () => {
    const { sanitizeAnalyticsProperties } = await import('./analytics')
    const properties = {
      '$current_url': 'https://app.example/?token=current',
      '$referrer': 'https://referrer.example/path?token=referrer',
      '$initial_current_url': 'https://app.example/auth/callback?code=initial',
      '$initial_referrer': 'file:///private/source.html',
      safe: 'unchanged',
    }

    expect(sanitizeAnalyticsProperties(properties)).toEqual({
      // Replaced by the logical screen, not merely stripped — see the screen tests.
      '$current_url': 'app://operon/desktop/home',
      '$referrer': 'https://referrer.example/path',
      '$initial_current_url': 'https://app.example/auth/callback',
      '$initial_referrer': 'app://operon',
      safe: 'unchanged',
    })
  })

  it('replaces the on-disk path the packaged app reports as its pathname', async () => {
    const { sanitizeAnalyticsProperties } = await import('./analytics')

    // `$pathname` is location.pathname, which no URL rule covered: on the
    // packaged desktop app it is wherever the user installed the bundle.
    expect(sanitizeAnalyticsProperties({
      '$pathname': '/Users/someone/dev/operon/dist/index.html',
      '$initial_pathname': '/Users/someone/dev/operon/dist/index.html',
    })).toEqual({
      '$pathname': '/desktop/home',
      '$initial_pathname': '/desktop/home',
    })
  })

  it('sanitizes URLs through the supported before-send hook', async () => {
    const { sanitizeAnalyticsEvent } = await import('./analytics')

    expect(sanitizeAnalyticsEvent({
      uuid: 'event-id',
      event: '$pageview' as const,
      properties: { '$referrer': 'https://referrer.example/path?token=secret#private' },
    })?.properties['$referrer']).toBe('https://referrer.example/path')
    expect(sanitizeAnalyticsEvent(null)).toBeNull()
  })
})

describe('analytics platform attribution', () => {
  it('tags every event with the surface it came from', async () => {
    const { sanitizeAnalyticsEvent } = await import('./analytics')

    // Injected through before_send rather than register(), so it also covers
    // the events we never construct: autocapture, web vitals, exceptions, and
    // the initial pageview PostHog emits from inside init().
    expect(sanitizeAnalyticsEvent({
      uuid: 'event-id',
      event: '$autocapture' as const,
      properties: {},
    })?.properties.app_platform).toBe('desktop')
  })

  it('lets an explicit property win over the detected surface', async () => {
    const { sanitizeAnalyticsEvent } = await import('./analytics')

    expect(sanitizeAnalyticsEvent({
      uuid: 'event-id',
      event: 'app_opened' as const,
      properties: { app_platform: 'ios' },
    })?.properties.app_platform).toBe('ios')
  })

  it('records the surface on the person record at sign-in', async () => {
    const { initAnalytics, syncAnalyticsIdentity } = await import('./analytics')
    initAnalytics()
    syncAnalyticsIdentity('user-1')

    expect(posthogMock.identify).toHaveBeenCalledWith('user-1', { app_platform: 'desktop' })
  })
})

describe('analytics screens', () => {
  it('reports the screen as the URL, since the app has no router', async () => {
    const { initAnalytics, setAnalyticsScreen, sanitizeAnalyticsProperties } = await import('./analytics')
    initAnalytics()
    setAnalyticsScreen('settings')

    expect(sanitizeAnalyticsProperties({ '$current_url': 'file:///whatever' }))
      .toEqual({ '$current_url': 'app://operon/desktop/settings' })
  })

  it('emits the pageview PostHog cannot emit itself', async () => {
    const { initAnalytics, setAnalyticsScreen } = await import('./analytics')
    initAnalytics()
    posthogMock.capture.mockClear()

    setAnalyticsScreen('channel')
    // Navigating back to the same screen is not a new pageview.
    setAnalyticsScreen('channel')

    expect(posthogMock.capture).toHaveBeenCalledTimes(1)
    expect(posthogMock.capture).toHaveBeenCalledWith('$pageview')
  })
})

describe('analytics identity', () => {
  it('binds events to the account so surfaces reconcile to one person', async () => {
    const { initAnalytics, syncAnalyticsIdentity } = await import('./analytics')
    initAnalytics()

    syncAnalyticsIdentity('user-1')
    // Repeat calls are free: the gate re-runs this on every phase change.
    syncAnalyticsIdentity('user-1')

    expect(posthogMock.identify).toHaveBeenCalledTimes(1)
  })

  it('resets on sign-out so the next user does not inherit the identity', async () => {
    const { initAnalytics, syncAnalyticsIdentity } = await import('./analytics')
    initAnalytics()
    syncAnalyticsIdentity('user-1')
    syncAnalyticsIdentity(null)

    expect(posthogMock.reset).toHaveBeenCalledTimes(1)
  })

  it('does nothing when analytics never initialized', async () => {
    localStorage.setItem('operon.analytics.optOut', '1')
    const { initAnalytics, syncAnalyticsIdentity } = await import('./analytics')
    initAnalytics()
    syncAnalyticsIdentity('user-1')

    expect(posthogMock.identify).not.toHaveBeenCalled()
  })
})

describe('analytics configuration', () => {
  it('enables masked diagnostics while keeping sensitive capture disabled', async () => {
    const { initAnalytics } = await import('./analytics')
    initAnalytics()

    const config = posthogMock.init.mock.calls[0]?.[1]
    expect(config).toMatchObject({
      autocapture: {
        dom_event_allowlist: ['click', 'change', 'submit'],
        capture_copied_text: false,
      },
      capture_pageview: 'history_change',
      capture_pageleave: true,
      // Off by design: this app's webview and canvas surfaces make the dead-click
      // heuristic report almost entirely false positives. See analytics.ts.
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
      mask_all_text: true,
      mask_all_element_attributes: true,
      before_send: expect.any(Function),
    })
    expect(config).not.toHaveProperty('sanitize_properties')
  })

  it('re-enables PostHog during production startup when its consent state is stale', async () => {
    vi.stubEnv('DEV', false)
    posthogMock.has_opted_out_capturing.mockReturnValue(true)
    const { initAnalytics } = await import('./analytics')
    initAnalytics()

    expect(posthogMock.opt_in_capturing).toHaveBeenCalledWith({ captureEventName: false })
  })

  it('emits at most one active pageview per UTC day', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-10T23:59:00Z'))
    const { windowTarget } = installBrowserGlobals()
    const { initAnalytics } = await import('./analytics')
    initAnalytics()

    windowTarget.dispatchEvent(new Event('focus'))
    expect(posthogMock.capture).not.toHaveBeenCalledWith('$pageview')

    vi.setSystemTime(new Date('2026-08-11T00:01:00Z'))
    windowTarget.dispatchEvent(new Event('keydown'))
    windowTarget.dispatchEvent(new Event('pointerdown'))

    expect(posthogMock.capture.mock.calls.filter(([event]) => event === '$pageview')).toHaveLength(1)
  })
})
