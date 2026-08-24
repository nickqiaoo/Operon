import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNodeAnalytics, type NodeCapturePayload } from './analytics'

function createSink() {
  const sent: NodeCapturePayload[] = []
  return { sent, capture: (payload: NodeCapturePayload) => { sent.push(payload) } }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('main-process analytics gate', () => {
  it('sends nothing before the renderer reports', () => {
    const sink = createSink()
    createNodeAnalytics(sink).capture('app_crash', { process: 'main' })

    // Sending here would attribute the event to a placeholder id, and would
    // ignore an opt-out that has not been read yet.
    expect(sink.sent).toEqual([])
  })

  it('releases buffered events under the real distinct id', () => {
    const sink = createSink()
    const analytics = createNodeAnalytics(sink)

    analytics.capture('app_crash', { process: 'main' })
    analytics.capture('llm_cache_break', {})
    analytics.applyRendererState('user-1', false)

    expect(sink.sent.map((e) => e.event)).toEqual(['app_crash', 'llm_cache_break'])
    expect(sink.sent.every((e) => e.distinctId === 'user-1')).toBe(true)
  })

  it('drops buffered events when the user has opted out', () => {
    const sink = createSink()
    const analytics = createNodeAnalytics(sink)

    analytics.capture('app_crash', { process: 'main' })
    analytics.applyRendererState('', true)
    analytics.capture('llm_cache_break', {})

    expect(sink.sent).toEqual([])
  })

  it('stops sending when consent is withdrawn mid-session', () => {
    const sink = createSink()
    const analytics = createNodeAnalytics(sink)
    analytics.applyRendererState('user-1', false)

    analytics.capture('before', {})
    analytics.applyRendererState('', true)
    analytics.capture('after', {})

    expect(sink.sent.map((e) => e.event)).toEqual(['before'])
  })

  it('follows the renderer to a new distinct id after identify()', () => {
    const sink = createSink()
    const analytics = createNodeAnalytics(sink)

    analytics.applyRendererState('anon-device', false)
    analytics.capture('before', {})
    analytics.applyRendererState('account-42', false)
    analytics.capture('after', {})

    expect(sink.sent.map((e) => e.distinctId)).toEqual(['anon-device', 'account-42'])
  })

  it('tags events as the desktop app', () => {
    const sink = createSink()
    const analytics = createNodeAnalytics(sink)
    analytics.applyRendererState('user-1', false)
    analytics.capture('app_crash', { process: 'main' })

    expect(sink.sent[0]?.properties).toEqual({ app_platform: 'desktop', process: 'main' })
  })

  it('lets an explicit property win over the default tag', () => {
    const sink = createSink()
    const analytics = createNodeAnalytics(sink)
    analytics.applyRendererState('user-1', false)
    analytics.capture('e', { app_platform: 'other' })

    expect(sink.sent[0]?.properties.app_platform).toBe('other')
  })

  it('drops events when the renderer never reports at all', () => {
    const sink = createSink()
    const analytics = createNodeAnalytics(sink, { timeoutMs: 1000 })
    analytics.capture('app_crash', { process: 'main' })

    vi.advanceTimersByTime(1000)
    // A renderer that crashed during boot never told us about consent, so the
    // only safe reading is that it was withheld.
    analytics.applyRendererState('user-1', false)

    expect(sink.sent).toEqual([])
  })

  it('bounds the buffer so a silent renderer cannot grow it forever', () => {
    const sink = createSink()
    const analytics = createNodeAnalytics(sink, { maxPending: 2 })

    for (let i = 0; i < 10; i++) analytics.capture(`e${i}`, {})
    analytics.applyRendererState('user-1', false)

    expect(sink.sent.map((e) => e.event)).toEqual(['e0', 'e1'])
  })
})
