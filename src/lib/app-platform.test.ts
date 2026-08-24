import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveAppPlatform, windowDisplayMode, type AppPlatformInput } from './app-platform'

/**
 * The five surfaces this exists to tell apart. Desktop is Electron; the other
 * four all ship the identical web bundle, which is exactly why PostHog cannot
 * separate them on its own.
 */
function input(overrides: Partial<AppPlatformInput> = {}): AppPlatformInput {
  return { target: 'web', native: 'web', displayMode: 'browser', ...overrides }
}

/** Stub `window.matchMedia` so only the listed queries report a match. */
function stubMatchMedia(matching: string[]): void {
  vi.stubGlobal('window', {
    matchMedia: (query: string) => ({ matches: matching.includes(query) }),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('app platform resolution', () => {
  it('reports the desktop shell regardless of window presentation', () => {
    expect(resolveAppPlatform(input({ target: 'electron', displayMode: 'browser' }))).toBe('desktop')
  })

  it('separates a browser tab from an installed PWA', () => {
    expect(resolveAppPlatform(input({ displayMode: 'browser' }))).toBe('web')
    expect(resolveAppPlatform(input({ displayMode: 'standalone' }))).toBe('pwa')
    expect(resolveAppPlatform(input({ displayMode: 'minimal-ui' }))).toBe('pwa')
  })

  it('does not mistake a full-screened browser tab for an installed PWA', () => {
    expect(resolveAppPlatform(input({ displayMode: 'fullscreen' }))).toBe('web')
  })

  it('separates the native shells from the PWA they share a bundle with', () => {
    expect(resolveAppPlatform(input({ native: 'ios' }))).toBe('ios')
    expect(resolveAppPlatform(input({ native: 'android' }))).toBe('android')
  })

  it('keeps the native shell tagged even when its web view claims standalone', () => {
    expect(resolveAppPlatform(input({ native: 'ios', displayMode: 'standalone' }))).toBe('ios')
  })
})

describe('display mode detection', () => {
  it('detects each installed presentation', () => {
    for (const mode of ['standalone', 'minimal-ui', 'fullscreen'] as const) {
      stubMatchMedia([`(display-mode: ${mode})`])
      expect(windowDisplayMode()).toBe(mode)
    }
  })

  it('falls back to the legacy iOS home-screen flag', () => {
    stubMatchMedia([])
    vi.stubGlobal('navigator', { standalone: true })

    expect(windowDisplayMode()).toBe('standalone')
  })

  it('reports a plain browser tab', () => {
    stubMatchMedia([])
    vi.stubGlobal('navigator', { standalone: false })

    expect(windowDisplayMode()).toBe('browser')
  })

  it('degrades to a browser tab where matchMedia is unavailable', () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', undefined)

    expect(windowDisplayMode()).toBe('browser')
  })
})
