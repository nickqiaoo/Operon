import { query } from '@anthropic-ai/claude-agent-sdk'
import type {
  Query,
  SDKControlGetUsageResponse,
  SDKRateLimitInfo,
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
 * Map a `rate_limit_event` push into the same window snapshot as the poll.
 *
 * The event's `unifiedWindows` is a full snapshot of every window, not just the
 * one `rateLimitType` names — so a push is a complete replacement for those
 * windows, not a partial update. It is **not** in the SDK's type declarations
 * (`SDKRateLimitInfo` stops at `utilization` / `overage*`), so it is validated
 * here field by field: an undeclared field can disappear in any CLI release,
 * and the poll has to keep working when it does.
 *
 * Two normalizations bring it onto the poll's units: the push reports
 * utilization as a 0-1 fraction where `/usage` reports 0-100, and `resetsAt` as
 * epoch seconds where the poll parses an ISO string into milliseconds.
 */
export function mapPushedRateLimitWindows(
  info: SDKRateLimitInfo,
): Record<string, RuntimeUsageLimitWindow> | null {
  const unified = (info as { unifiedWindows?: unknown }).unifiedWindows
  if (!unified || typeof unified !== 'object') return null

  const out: Record<string, RuntimeUsageLimitWindow> = {}
  for (const [key, raw] of Object.entries(unified as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const { utilization, resetsAt } = raw as { utilization?: unknown; resetsAt?: unknown }
    if (typeof utilization !== 'number' || !Number.isFinite(utilization)) continue

    const percent = utilization <= 1 ? utilization * 100 : utilization

    out[key] = {
      // The event's `status` describes the account, and `rateLimitType` names the
      // window that put it there — so only that window inherits it.
      status: key === info.rateLimitType && info.status ? info.status : 'allowed',
      // 0.56 * 100 is 56.00000000000001 in binary floating point. Round to a
      // tenth so the tail never reaches the UI, while a finer-grained push than
      // today's 1% steps would still survive.
      utilization: Math.round(percent * 10) / 10,
      ...(typeof resetsAt === 'number' && Number.isFinite(resetsAt)
        ? { resetsAt: resetsAt < 1e12 ? resetsAt * 1000 : resetsAt }
        : {}),
    }
  }

  return Object.keys(out).length > 0 ? out : null
}

/**
 * Whether `next` is an older snapshot of what `held` already describes.
 *
 * Usage within one window only ever grows, so a lower number for the same
 * window can only mean the reading was taken earlier — whatever else it says is
 * equally out of date, which is why the caller drops it whole rather than
 * salvaging fields from it. A genuinely new window arrives with a later
 * `resetsAt` and is free to start from zero.
 *
 * Reset times are compared with a tolerance because the two sources round
 * differently: a push carries epoch seconds (`1789744200` → `…200000`), a poll
 * parses an ISO string with sub-second precision (`…200526`). Comparing exactly
 * would read every pair as a different window and defeat the check.
 */
const SAME_WINDOW_TOLERANCE_MS = 60_000

function isStaleReading(held: RuntimeUsageLimitWindow, next: RuntimeUsageLimitWindow): boolean {
  // Without a reset time on both sides there is no evidence of a new window,
  // and assuming one would hand back exactly the regression this guards.
  const sameWindow =
    held.resetsAt === undefined ||
    next.resetsAt === undefined ||
    Math.abs(held.resetsAt - next.resetsAt) < SAME_WINDOW_TOLERANCE_MS

  return sameWindow && (next.utilization ?? 0) < (held.utilization ?? 0)
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

  /**
   * `force` clears the backoff before polling, for a user pressing Refresh.
   *
   * Only `retryAt` is cleared, not `failureStreak`: the streak is what the
   * account has taught us about how long being empty lasts, and pressing a
   * button says nothing about that. Resetting it too would let a held button
   * restart a CLI process every minute against an account that simply has no
   * plan limits to report.
   */
  async get(options?: { force?: boolean }): Promise<RuntimeUsageLimits | null> {
    if (options?.force) this.retryAt = 0
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

  /**
   * Fold a `rate_limit_event` push into the shared snapshot.
   *
   * Quota is account-scoped, so it does not matter which conversation's stream
   * the event arrived on — every reader of this probe wants it. This is the
   * only path that updates the snapshot without a poll, and it never touches
   * the backoff: a push is free, so it neither counts as a success that would
   * resume polling nor as a failure that would delay it.
   */
  applyPush(windows: Record<string, RuntimeUsageLimitWindow>): void {
    this.mergeWindows(windows)
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
      // `behaviors` is a scan of local transcripts we never read, and it costs
      // two orders of magnitude more than the quota itself: measured on this
      // account, 219-460ms with the scan against 1-4ms without, for byte-identical
      // rate-limit values.
      const usage = await active.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
        skipBehaviors: true,
      })
      if (usage.subscription_type) this.subscriptionType = usage.subscription_type

      const windows = mapUsageToRateLimitWindows(usage)
      // Either the account has no plan limits (API key / Bedrock / Vertex) or it
      // has not reported them yet. Indistinguishable here, so back off rather
      // than deciding which.
      if (!windows) return this.backoff('account reports no plan rate limits')

      this.failureStreak = 0
      this.retryAt = 0
      this.mergeWindows(windows)
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
   * Fold incoming windows in, dropping readings that predate what we hold.
   *
   * The two sources disagree by design: a push is derived from the response
   * headers of a request that just happened, while a poll asks the usage
   * endpoint, which can still be a percentage point behind. A poll landing
   * after a push would lower a number the user has already seen, and the badge
   * would visibly step back for no reason they can observe.
   */
  private mergeWindows(incoming: Record<string, RuntimeUsageLimitWindow>): void {
    const merged: Record<string, RuntimeUsageLimitWindow> = { ...this.windows }

    for (const [key, next] of Object.entries(incoming)) {
      const prev = merged[key]
      if (prev && isStaleReading(prev, next)) continue
      merged[key] = next
    }

    this.logChangedWindows(merged)
    this.windows = merged
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

  /** Current snapshot without triggering a poll. */
  peek(): RuntimeUsageLimits | null {
    return this.snapshot()
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
export function getClaudeAccountUsage(options?: {
  force?: boolean
}): Promise<RuntimeUsageLimits | null> {
  return probe.get(options)
}

/**
 * Record a `rate_limit_event` push against the account snapshot.
 *
 * Pushes land the moment usage moves (measured: one per 1% step, mid-turn),
 * where the poll is a periodic sweep — so this is what keeps the number live,
 * and the poll is left to cover what a push cannot see: spend by other clients
 * and window resets while this app sends nothing.
 */
export function applyClaudeUsagePush(info: SDKRateLimitInfo): boolean {
  const windows = mapPushedRateLimitWindows(info)
  if (!windows) return false
  probe.applyPush(windows)
  return true
}

/** The account snapshot as it stands, without polling. */
export function peekClaudeAccountUsage(): RuntimeUsageLimits | null {
  return probe.peek()
}

/** Stop the shared probe process (app shutdown). */
export function disposeClaudeUsageProbe(): Promise<void> {
  return probe.dispose()
}
