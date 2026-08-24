import { query } from '@anthropic-ai/claude-agent-sdk'
import type {
  Query,
  SDKControlGetUsageResponse,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { RuntimeUsageLimits, RuntimeUsageLimitWindow } from '../../types.js'
import { getRuntimeHost } from '../../host.js'
import { createRuntimeLogger } from '../../logger.js'

const logger = createRuntimeLogger('claude-usage')

const INIT_TIMEOUT_MS = 20_000

/**
 * Backoff for "no usage this time", doubling from a minute up to an hour.
 *
 * Every reason the probe comes back empty looks the same from here — a CLI that
 * isn't there yet, a poll that threw, an account that reports no plan limits —
 * and they differ only in how long they last, which is exactly what doubling
 * discovers on its own. A transient miss costs one minute; a genuinely
 * limit-less account (API key / Bedrock / Vertex) settles at one cheap probe an
 * hour instead of one every 30s.
 *
 * This replaces a permanent `unsupported` flag. That flag read a single empty
 * response as a fact about the account and never looked again, so one bad
 * moment — a cold start where the CLI hasn't synced quota yet — hid the badge
 * until the app was restarted, with no way for the user to tell why.
 */
const RETRY_BASE_MS = 60_000
const RETRY_MAX_MS = 60 * 60_000

/**
 * Map the structured `/usage` response into our window snapshot. The poll gives
 * ISO `resets_at` strings and no per-window status, so we normalize to an epoch
 * and mark `allowed` (the UI colors by remaining %, not status). Returns null
 * when plan limits don't apply (API key / Bedrock / Vertex).
 */
export function mapUsageToRateLimitWindows(
  usage: SDKControlGetUsageResponse,
): Record<string, RuntimeUsageLimitWindow> | null {
  const limits = usage.rate_limits
  if (!usage.rate_limits_available || !limits) return null

  const out: Record<string, RuntimeUsageLimitWindow> = {}
  const add = (key: string, window?: { utilization: number | null; resets_at: string | null } | null): void => {
    if (!window || typeof window.utilization !== 'number') return
    const resetsAt = window.resets_at ? Date.parse(window.resets_at) : Number.NaN
    out[key] = {
      status: 'allowed',
      utilization: window.utilization,
      ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
    }
  }

  add('five_hour', limits.five_hour)
  add('seven_day', limits.seven_day)
  add('seven_day_opus', limits.seven_day_opus)
  add('seven_day_sonnet', limits.seven_day_sonnet)
  // Per-model weekly windows (e.g. Fable) arrive as a dynamic array with a
  // server-supplied display name; carry the name inside the key so the UI can
  // label the window without a schema change.
  for (const entry of limits.model_scoped ?? []) {
    if (entry.display_name) add(`model_scoped:${entry.display_name}`, entry)
  }

  return Object.keys(out).length > 0 ? out : null
}

/**
 * Input that never yields. The CLI stays in streaming-input mode with stdin
 * open, so the process lives on without ever starting a turn — this probe must
 * never send a prompt or spend tokens.
 */
const silentInput: AsyncIterable<SDKUserMessage> = {
  // eslint-disable-next-line require-yield
  async *[Symbol.asyncIterator]() {
    await new Promise<never>(() => {})
  },
}

/**
 * One chat-less Claude CLI process, shared by the whole app, whose only job is
 * answering `get_usage`.
 *
 * Account quota is account-scoped, so a dedicated probe is strictly better than
 * asking a chat session: it needs no open conversation, it never competes with
 * a live message stream over the control channel (so it can be polled mid-turn),
 * and it survives tab closes. It is started lazily on the first request and then
 * kept — a single idle process costs little and every caller shares it.
 */
export class ClaudeUsageProbe {
  private active: Query | null = null
  private starting: Promise<Query | null> | null = null
  private inFlight: Promise<RuntimeUsageLimits | null> | null = null
  /** Merged across polls — a single response may carry only some windows. */
  private windows: Record<string, RuntimeUsageLimitWindow> = {}
  private subscriptionType: string | undefined
  /** Epoch ms before which polling is suppressed; 0 once a poll succeeds. */
  private retryAt = 0
  /** Consecutive empty polls — drives the backoff delay. */
  private failureStreak = 0

  async get(): Promise<RuntimeUsageLimits | null> {
    // Backing off: serve the last good snapshot (null if there never was one)
    // rather than starting a process we just decided to stop asking.
    if (Date.now() < this.retryAt) return this.snapshot()
    if (this.inFlight) return this.inFlight

    const request = this.fetch()
    this.inFlight = request
    try {
      return await request
    } finally {
      if (this.inFlight === request) this.inFlight = null
    }
  }

  async dispose(): Promise<void> {
    const active = this.active
    this.active = null
    this.starting = null
    if (!active) return
    try {
      await active.close()
    } catch {
      // Shutting down anyway.
    }
  }

  private async fetch(): Promise<RuntimeUsageLimits | null> {
    const active = await this.ensureQuery()
    if (!active) return this.backoff('no probe process')

    try {
      const usage = await active.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
      if (usage.subscription_type) this.subscriptionType = usage.subscription_type

      const windows = mapUsageToRateLimitWindows(usage)
      // Either the account has no plan limits (API key / Bedrock / Vertex) or it
      // has not reported them yet. Indistinguishable here, so back off rather
      // than deciding which.
      if (!windows) return this.backoff('account reports no plan rate limits')

      this.failureStreak = 0
      this.retryAt = 0
      this.logChangedWindows(windows)
      this.windows = { ...this.windows, ...windows }
      return this.snapshot()
    } catch (error) {
      return this.backoff(
        `usage poll failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Stop polling for a while, and drop the CLI process — it earns nothing while
   * we aren't asking, and a poll that just threw may be why. The next attempt
   * past `retryAt` starts a fresh one.
   */
  private backoff(reason: string): RuntimeUsageLimits | null {
    this.failureStreak += 1
    // Clamp the exponent, not just the product: 2 ** 1024 is Infinity, and
    // arithmetic on it is a worse thing to depend on than a bounded shift.
    const delay = Math.min(RETRY_BASE_MS * 2 ** Math.min(this.failureStreak - 1, 20), RETRY_MAX_MS)
    this.retryAt = Date.now() + delay
    logger.info(
      `${reason}; next usage attempt in ${Math.round(delay / 1000)}s (streak ${this.failureStreak})`,
    )
    void this.dispose()
    return this.snapshot()
  }

  /**
   * The badge shows a single number — whichever window is most consumed — so a
   * window resetting or the account re-reporting looks like the quota jumping
   * on its own. Log every window whose utilization moved so those jumps can be
   * told apart from a UI problem after the fact.
   */
  private logChangedWindows(next: Record<string, RuntimeUsageLimitWindow>): void {
    const moved = Object.entries(next).filter(
      ([key, window]) => this.windows[key]?.utilization !== window.utilization,
    )
    if (moved.length === 0) return
    const summary = moved
      .map(([key, window]) => `${key} ${this.windows[key]?.utilization ?? '-'}→${window.utilization}`)
      .join(', ')
    logger.info(`usage changed: ${summary}`)
  }

  private snapshot(): RuntimeUsageLimits | null {
    if (Object.keys(this.windows).length === 0) return null
    return {
      windows: this.windows,
      ...(this.subscriptionType ? { subscriptionType: this.subscriptionType } : {}),
    }
  }

  private async ensureQuery(): Promise<Query | null> {
    if (this.active) return this.active
    if (this.starting) return this.starting

    const start = this.startQuery()
    this.starting = start
    try {
      return await start
    } finally {
      if (this.starting === start) this.starting = null
    }
  }

  private async startQuery(): Promise<Query | null> {
    const cliPath = getRuntimeHost().resolveCliPath('claude-code')
    if (!cliPath) {
      logger.info('CLI not available, skipping usage probe')
      return null
    }

    let started: Query | null = null
    try {
      started = query({
        prompt: silentInput,
        options: {
          pathToClaudeCodeExecutable: cliPath,
          persistSession: false,
          // Nothing here runs a turn, so skip user/project settings entirely —
          // that keeps MCP servers, hooks and workspace config out of the probe.
          settingSources: [],
        },
      })

      await withTimeout(started.initializationResult(), INIT_TIMEOUT_MS)

      // Nobody reads this process's messages; drain so they can't pile up.
      void (async () => {
        try {
          for await (const _message of started as AsyncIterable<unknown>) {
            // discard
          }
        } catch {
          // The query was closed or the CLI died; the next poll restarts it.
        }
      })()

      this.active = started
      logger.info('Usage probe query started')
      return started
    } catch (error) {
      logger.error(`Failed to start usage probe: ${error instanceof Error ? error.message : String(error)}`)
      try {
        await started?.close()
      } catch {
        // ignore close errors
      }
      return null
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const probe = new ClaudeUsageProbe()

/**
 * Account-level Claude subscription quota, independent of any conversation.
 * Returns null when the CLI is unavailable or the account has no plan limits.
 */
export function getClaudeAccountUsage(): Promise<RuntimeUsageLimits | null> {
  return probe.get()
}

/** Stop the shared probe process (app shutdown). */
export function disposeClaudeUsageProbe(): Promise<void> {
  return probe.dispose()
}
