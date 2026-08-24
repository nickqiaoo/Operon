import type { LanguageModelUsage } from 'ai'

/**
 * Per-conversation LLM prompt-cache monitor.
 *
 * Every provider surfaces a PER-CALL usage sample through `runAgentTurn` (claude-code
 * emits one `message-metadata` per Anthropic `message_stop`; codex per `token_count`;
 * others via `finish-step.usage`) — each carrying THAT call's own cache_read / cache_write
 * (not a running total). This module watches, per conversation, for the signature of a
 * cache-busting regression: a conversation that was reading a large prompt cache on every
 * call suddenly stops reading it (cache_read collapses) even though the calls are close
 * together in time (so the cache cannot have expired by TTL). That is the fingerprint of a
 * change that destabilised the cached prompt prefix (e.g. a volatile token in the system
 * prompt, reordered tools, non-deterministic serialization).
 *
 * We report ONLY the anomaly (`llm_cache_break`), not every call: a healthy build emits
 * ~zero of these, so the per-version COUNT of break events is itself the monitoring signal.
 * Flip EMIT_ALL_SAMPLES to also emit a per-call `llm_call` sample if you later want full
 * hit-rate dashboards (much higher event volume).
 */

// --- Telemetry sink (wired by startServer, backed by the main-process posthog-node) -------
type CaptureFn = (event: string, properties: Record<string, unknown>) => void
let sink: CaptureFn | null = null
let appVersion: string | undefined

/** Wire the analytics sink + app version. Called once from `startServer`. */
export function setTelemetrySink(capture: CaptureFn, version?: string): void {
  sink = capture
  appVersion = version
}

// --- Detection tuning ---------------------------------------------------------------------
/**
 * Gaps >= this (seconds) are treated as possible natural cache-TTL expiry, NOT a bug —
 * a legitimate cache_read=0 after the user idled. Must match the configured prompt-cache
 * TTL: we use the 1-hour cache, so a collapse is only a real regression when the calls are
 * within the hour the cache is guaranteed alive. (Set too low, real bugs whose gap falls
 * between the true TTL and this value would be misread as expiry and silently missed.)
 */
const CACHE_TTL_SECONDS = 3600
/** Only treat a drop as a collapse if the PREVIOUS call was actually reading a real cache. */
const MIN_PREV_CACHE_READ = 2000
/** cache_read below `prev * COLLAPSE_RATIO` counts as a collapse. */
const COLLAPSE_RATIO = 0.5
/** Bound the per-conversation state map so a long-running app can't leak memory. */
const MAX_TRACKED_CONVERSATIONS = 1000
/** Set true to also emit a per-call `llm_call` sample (full data, high volume). */
const EMIT_ALL_SAMPLES = false

interface ConvState {
  callSeq: number
  prevCacheRead: number
  prevTsMs: number
  /** Last usage tuple, to dedup provider re-emits of an unchanged snapshot. */
  lastTuple: string
}

const state = new Map<string, ConvState>()

interface UsageNumbers {
  cacheRead: number
  cacheWrite: number
  inputTokens: number
  outputTokens: number
}

/**
 * Read cache tokens out of the AI-SDK usage. Both claude-code and codex place them in
 * `inputTokenDetails.{cacheReadTokens,cacheWriteTokens}` (with `cachedInputTokens` as a
 * fallback for cache read), and report `inputTokens` as the FULL prompt (cache included).
 */
function readUsage(usage: LanguageModelUsage): UsageNumbers {
  const u = usage as unknown as {
    inputTokens?: number
    outputTokens?: number
    cachedInputTokens?: number
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number }
  }
  return {
    cacheRead: u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens ?? 0,
    cacheWrite: u.inputTokenDetails?.cacheWriteTokens ?? 0,
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
  }
}

export interface CacheSampleContext {
  /** Stable conversation key (server chatId). */
  conversationId: string
  providerId: string
  modelId?: string
}

/**
 * Record one per-call usage sample. Emits `llm_cache_break` when the cache_read collapses
 * relative to the previous call in the same conversation while the calls are close in time.
 */
export function recordUsageSample(
  ctx: CacheSampleContext,
  usage: LanguageModelUsage,
  nowMs: number = Date.now(),
): void {
  const n = readUsage(usage)
  // Ignore empty/zero usage (errors, warm-ups) — nothing meaningful to compare.
  if (n.inputTokens === 0 && n.cacheRead === 0 && n.cacheWrite === 0 && n.outputTokens === 0) return

  const tuple = `${n.cacheRead}:${n.cacheWrite}:${n.inputTokens}:${n.outputTokens}`
  const prev = state.get(ctx.conversationId)
  // Dedup provider re-emits of the SAME usage (codex re-fires metadata on rate-limit /
  // goal updates with an unchanged usage snapshot).
  if (prev && prev.lastTuple === tuple) return

  const secondsSincePrev = prev ? (nowMs - prev.prevTsMs) / 1000 : Infinity
  const callSeq = prev ? prev.callSeq + 1 : 0
  // `inputTokens` is the full prompt for the providers we've verified, so uncached = total - cache.
  const totalPrompt = Math.max(n.inputTokens, n.cacheRead + n.cacheWrite)
  const cacheReadRatio = totalPrompt > 0 ? n.cacheRead / totalPrompt : 0

  const isBreak =
    prev !== undefined &&
    secondsSincePrev < CACHE_TTL_SECONDS &&
    prev.prevCacheRead >= MIN_PREV_CACHE_READ &&
    n.cacheRead < prev.prevCacheRead * COLLAPSE_RATIO

  if (isBreak && prev) {
    sink?.('llm_cache_break', {
      conversation_id: ctx.conversationId,
      provider_id: ctx.providerId,
      model: ctx.modelId,
      call_seq: callSeq,
      cache_read_tokens: n.cacheRead,
      prev_cache_read_tokens: prev.prevCacheRead,
      cache_write_tokens: n.cacheWrite,
      input_tokens: n.inputTokens,
      output_tokens: n.outputTokens,
      cache_read_ratio: cacheReadRatio,
      seconds_since_prev_call: Math.round(secondsSincePrev),
      app_version: appVersion,
    })
  }

  if (EMIT_ALL_SAMPLES) {
    sink?.('llm_call', {
      conversation_id: ctx.conversationId,
      provider_id: ctx.providerId,
      model: ctx.modelId,
      call_seq: callSeq,
      cache_read_tokens: n.cacheRead,
      cache_write_tokens: n.cacheWrite,
      input_tokens: n.inputTokens,
      output_tokens: n.outputTokens,
      cache_read_ratio: cacheReadRatio,
      seconds_since_prev_call: prev ? Math.round(secondsSincePrev) : null,
      suspected_cache_break: isBreak,
      app_version: appVersion,
    })
  }

  // Advance state (evict the oldest conversation first if we're at the cap).
  if (!prev && state.size >= MAX_TRACKED_CONVERSATIONS) evictOldest()
  state.set(ctx.conversationId, {
    callSeq,
    prevCacheRead: n.cacheRead,
    prevTsMs: nowMs,
    lastTuple: tuple,
  })
}

function evictOldest(): void {
  let oldestKey: string | undefined
  let oldestTs = Infinity
  for (const [k, v] of state) {
    if (v.prevTsMs < oldestTs) {
      oldestTs = v.prevTsMs
      oldestKey = k
    }
  }
  if (oldestKey !== undefined) state.delete(oldestKey)
}

/** Test/maintenance hook: drop all tracked conversation state. */
export function __resetCacheMonitor(): void {
  state.clear()
}
