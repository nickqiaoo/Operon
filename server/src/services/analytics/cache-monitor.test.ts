import { describe, it, expect, beforeEach } from 'vitest'
import type { LanguageModelUsage } from 'ai'
import {
  recordUsageSample,
  setTelemetrySink,
  __resetCacheMonitor,
  type CacheSampleContext,
} from './cache-monitor.js'

/** Build an AI-SDK usage object shaped the way claude-code / codex report it. */
const usage = (cacheRead: number, cacheWrite: number, uncached: number, output = 100): LanguageModelUsage =>
  ({
    inputTokens: cacheRead + cacheWrite + uncached, // full prompt (cache included)
    outputTokens: output,
    cachedInputTokens: cacheRead,
    inputTokenDetails: { cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
  }) as unknown as LanguageModelUsage

const ctx: CacheSampleContext = { conversationId: 'chat-1', providerId: 'claude-code', modelId: 'opus' }

const SEC = 1000
let events: Array<{ event: string; props: Record<string, unknown> }>

beforeEach(() => {
  __resetCacheMonitor()
  events = []
  setTelemetrySink((event, props) => events.push({ event, props }))
})

describe('cache-monitor', () => {
  it('does not emit on the first sample of a conversation', () => {
    recordUsageSample(ctx, usage(0, 5000, 200), 0)
    expect(events).toHaveLength(0)
  })

  it('stays quiet while an ongoing conversation keeps reading a large cache', () => {
    recordUsageSample(ctx, usage(0, 5000, 200), 0) // first call: writes cache
    recordUsageSample(ctx, usage(5000, 400, 100), 2 * SEC) // reads it back
    recordUsageSample(ctx, usage(5400, 300, 100), 4 * SEC) // grows, still reading
    expect(events).toHaveLength(0)
  })

  it('emits llm_cache_break when cache_read collapses between close-together calls', () => {
    recordUsageSample(ctx, usage(0, 5000, 200), 0)
    recordUsageSample(ctx, usage(5000, 400, 100), 2 * SEC) // healthy, prevCacheRead=5000
    recordUsageSample(ctx, usage(0, 5300, 100), 4 * SEC) // BUG: prefix busted → cache_read 0

    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('llm_cache_break')
    expect(events[0].props).toMatchObject({
      conversation_id: 'chat-1',
      provider_id: 'claude-code',
      cache_read_tokens: 0,
      prev_cache_read_tokens: 5000,
      seconds_since_prev_call: 2,
    })
  })

  it('does NOT flag a cache_read=0 after an idle gap longer than the TTL (natural expiry)', () => {
    recordUsageSample(ctx, usage(0, 5000, 200), 0)
    recordUsageSample(ctx, usage(5000, 400, 100), 2 * SEC)
    recordUsageSample(ctx, usage(0, 5300, 100), 2 * SEC + 4000 * SEC) // 4000s gap > 3600s (1h) TTL
    expect(events).toHaveLength(0)
  })

  it('still flags a collapse after a long idle that is within the 1h TTL', () => {
    recordUsageSample(ctx, usage(0, 5000, 200), 0)
    recordUsageSample(ctx, usage(5000, 400, 100), 2 * SEC)
    recordUsageSample(ctx, usage(0, 5300, 100), 2 * SEC + 1800 * SEC) // 30min gap < 1h → real bug
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('llm_cache_break')
  })

  it('dedups a provider re-emitting an unchanged usage snapshot', () => {
    recordUsageSample(ctx, usage(0, 5000, 200), 0)
    recordUsageSample(ctx, usage(5000, 400, 100), 2 * SEC)
    recordUsageSample(ctx, usage(5000, 400, 100), 3 * SEC) // identical → skip
    recordUsageSample(ctx, usage(0, 5300, 100), 4 * SEC) // collapse vs the deduped 5000
    // Only the collapse fires; the duplicate neither emits nor advances the baseline.
    expect(events).toHaveLength(1)
    expect(events[0].props.prev_cache_read_tokens).toBe(5000)
  })

  it('ignores collapses when the prior cache read was too small to matter', () => {
    recordUsageSample(ctx, usage(0, 500, 200), 0)
    recordUsageSample(ctx, usage(1000, 100, 100), 2 * SEC) // prevCacheRead=1000 < 2000 floor
    recordUsageSample(ctx, usage(0, 1200, 100), 4 * SEC)
    expect(events).toHaveLength(0)
  })

  it('keeps conversations independent', () => {
    recordUsageSample(ctx, usage(0, 5000, 200), 0)
    recordUsageSample(ctx, usage(5000, 400, 100), 2 * SEC)
    // A different conversation's first sample must not be compared to chat-1.
    recordUsageSample({ ...ctx, conversationId: 'chat-2' }, usage(0, 6000, 100), 3 * SEC)
    expect(events).toHaveLength(0)
  })
})
