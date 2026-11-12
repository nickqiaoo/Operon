import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk'

// `vi.mock` is hoisted above this file's own statements, so the spy it closes
// over has to be hoisted with it.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}))

const { createRuntimeContext } = await import('../../context.js')
const ctx = createRuntimeContext({ resolveBinary: () => '/usr/local/bin/claude' })

const { ClaudeUsageProbe, mapUsageToRateLimitWindows, mapPushedRateLimitWindows } = await import('./usage-probe.js')

/** Mirrors `RETRY_MAX_MS` in the probe. */
const RETRY_MAX_MS = 60 * 60_000

/** A `/usage` response carrying the fields the probe reads; the rest is unused. */
const usageResponse = (
  overrides: Partial<SDKControlGetUsageResponse> = {},
): SDKControlGetUsageResponse =>
  ({
    subscription_type: 'pro',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 33, resets_at: '2026-08-17T12:39:59.825197+00:00' },
    },
    ...overrides,
  }) as SDKControlGetUsageResponse

/** Minimal stand-in for the SDK `Query` the probe drives. */
const fakeQuery = (usage: () => Promise<SDKControlGetUsageResponse>) => ({
  initializationResult: () => Promise.resolve({}),
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage,
  close: vi.fn(async () => {}),
  async *[Symbol.asyncIterator]() {
    // No messages: this probe never runs a turn.
  },
})

describe('ClaudeUsageProbe merge', () => {
  const win = (utilization: number, resetsAt: number) => ({
    status: 'allowed' as const,
    utilization,
    resetsAt,
  })

  /** The reset time the default `usageResponse` reports, in ms. */
  const FIVE_HOUR_RESET = Date.parse('2026-08-17T12:39:59.825197+00:00')

  beforeEach(() => {
    queryMock.mockReturnValue(fakeQuery(async () => usageResponse()))
  })

  it('drops a reading that predates the one it holds', async () => {
    const probe = new ClaudeUsageProbe(ctx)
    await probe.get()

    probe.applyPush({ five_hour: win(56, FIVE_HOUR_RESET) })
    expect(probe.peek()?.windows.five_hour.utilization).toBe(56)

    // Same window (reset times match within tolerance), lower usage: this
    // reading was taken earlier, so none of it is kept.
    probe.applyPush({
      five_hour: { status: 'allowed_warning', utilization: 55, resetsAt: FIVE_HOUR_RESET + 500 },
    })
    expect(probe.peek()?.windows.five_hour).toEqual({
      status: 'allowed',
      utilization: 56,
      resetsAt: FIVE_HOUR_RESET,
    })
  })

  it('still drops to zero when the window actually resets', async () => {
    const probe = new ClaudeUsageProbe(ctx)
    await probe.get()
    probe.applyPush({ five_hour: win(98, FIVE_HOUR_RESET) })

    // A later resetsAt is a new window, so usage is allowed to fall.
    probe.applyPush({ five_hour: win(1, FIVE_HOUR_RESET + 5 * 60 * 60_000) })
    expect(probe.peek()?.windows.five_hour.utilization).toBe(1)
  })
})

describe('ClaudeUsageProbe poll vs push', () => {
  const WEEKLY_RESET_ISO = '2026-11-15T03:00:00.888174+00:00'
  const WEEKLY_RESET = Date.parse(WEEKLY_RESET_ISO)

  const weekly = (utilization: number, modelScoped: Array<{ name: string; utilization: number }> = []) =>
    usageResponse({
      rate_limits: {
        seven_day: { utilization, resets_at: WEEKLY_RESET_ISO },
        model_scoped: modelScoped.map(({ name, utilization: used }) => ({
          display_name: name,
          utilization: used,
          resets_at: WEEKLY_RESET_ISO,
        })),
      },
    } as Partial<SDKControlGetUsageResponse>)

  const pushed = (utilization: number) => ({ status: 'allowed' as const, utilization, resetsAt: WEEKLY_RESET })

  /** A probe whose polls answer with whatever `next` holds at the time. */
  const probeAnswering = () => {
    const state = { next: weekly(0) }
    queryMock.mockImplementation(() => fakeQuery(async () => state.next))
    return { probe: new ClaudeUsageProbe(ctx), state }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-11T09:00:00Z'))
    queryMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('takes a lower poll once the push it would undo is no longer fresh', async () => {
    const { probe, state } = probeAnswering()
    state.next = weekly(99)
    await probe.get()
    probe.applyPush({ seven_day: pushed(100) })

    // The limit is reset by hand: same `resetsAt`, usage back near zero. This
    // is what used to be read as an old reading and held at 100 for good.
    vi.advanceTimersByTime(3 * 60_000)
    state.next = weekly(2)
    expect((await probe.get())?.windows.seven_day.utilization).toBe(2)
  })

  it('keeps a fresh push over a poll that is still catching up to it', async () => {
    const { probe, state } = probeAnswering()
    state.next = weekly(40)
    await probe.get()
    probe.applyPush({ seven_day: pushed(42) })

    vi.advanceTimersByTime(10_000)
    state.next = weekly(41)
    expect((await probe.get())?.windows.seven_day.utilization).toBe(42)
  })

  it('takes a lower poll that has never raced a push', async () => {
    const { probe, state } = probeAnswering()
    state.next = weekly(100)
    await probe.get()

    state.next = weekly(2)
    expect((await probe.get())?.windows.seven_day.utilization).toBe(2)
  })

  it('takes a forced poll as is, even right after a push', async () => {
    const { probe, state } = probeAnswering()
    state.next = weekly(99)
    await probe.get()
    probe.applyPush({ seven_day: pushed(100) })

    state.next = weekly(2)
    expect((await probe.get({ force: true }))?.windows.seven_day.utilization).toBe(2)
  })

  it('still lets a push only raise a window it shares', async () => {
    const { probe, state } = probeAnswering()
    state.next = weekly(2)
    await probe.get()
    probe.applyPush({ seven_day: pushed(5) })

    // Pushes from different sessions can land out of order.
    probe.applyPush({ seven_day: pushed(4) })
    expect(probe.peek()?.windows.seven_day.utilization).toBe(5)
  })

  it('files the pushed per-model window under the one model the poll named', async () => {
    const { probe, state } = probeAnswering()
    state.next = weekly(10, [{ name: 'Fable', utilization: 30 }])
    await probe.get()

    probe.applyPush({ seven_day_overage_included: pushed(31) })
    const windows = probe.peek()?.windows
    expect(windows?.['model_scoped:Fable']?.utilization).toBe(31)
    expect(windows?.seven_day_overage_included).toBeUndefined()
  })

  it('keeps the pushed per-model window apart until a poll names it, then folds it in', async () => {
    const { probe, state } = probeAnswering()
    probe.applyPush({ seven_day_overage_included: pushed(39) })
    expect(probe.peek()?.windows.seven_day_overage_included?.utilization).toBe(39)

    state.next = weekly(10, [{ name: 'Fable', utilization: 40 }])
    const windows = (await probe.get())?.windows
    expect(windows?.['model_scoped:Fable']?.utilization).toBe(40)
    expect(windows?.seven_day_overage_included).toBeUndefined()
  })

  it('does not guess which model a push means when there are several', async () => {
    const { probe, state } = probeAnswering()
    state.next = weekly(10, [
      { name: 'Fable', utilization: 30 },
      { name: 'Other', utilization: 5 },
    ])
    await probe.get()

    probe.applyPush({ seven_day_overage_included: pushed(31) })
    const windows = probe.peek()?.windows
    expect(windows?.seven_day_overage_included?.utilization).toBe(31)
    expect(windows?.['model_scoped:Fable']?.utilization).toBe(30)
    expect(windows?.['model_scoped:Other']?.utilization).toBe(5)
  })
})

describe('mapPushedRateLimitWindows', () => {
  /** Shaped after a real `rate_limit_event` captured from the CLI. */
  const pushInfo = (overrides: Record<string, unknown> = {}) =>
    ({
      status: 'allowed_warning',
      rateLimitType: 'seven_day',
      utilization: 0.89,
      unifiedWindows: {
        five_hour: { utilization: 0.56, resetsAt: 1789744200 },
        seven_day: { utilization: 0.89, resetsAt: 1789873200 },
      },
      ...overrides,
    }) as never

  it('normalizes the push onto the poll units', () => {
    const windows = mapPushedRateLimitWindows(pushInfo())

    // 0-1 fraction becomes 0-100, epoch seconds become milliseconds.
    expect(windows?.five_hour).toEqual({
      status: 'allowed',
      utilization: 56,
      resetsAt: 1789744200_000,
    })
    // Only the window `rateLimitType` names inherits the account-level status.
    expect(windows?.seven_day.status).toBe('allowed_warning')
  })

  it('returns null when the undeclared field is absent', () => {
    expect(mapPushedRateLimitWindows(pushInfo({ unifiedWindows: undefined }))).toBeNull()
    expect(mapPushedRateLimitWindows(pushInfo({ unifiedWindows: {} }))).toBeNull()
  })

  it('skips windows without a usable utilization', () => {
    const windows = mapPushedRateLimitWindows(
      pushInfo({
        unifiedWindows: {
          five_hour: { utilization: 0.5 },
          broken: { utilization: null },
          also_broken: {},
        },
      }),
    )

    expect(Object.keys(windows ?? {})).toEqual(['five_hour'])
    // No resetsAt in the payload means no resetsAt in the result, not NaN.
    expect(windows?.five_hour.resetsAt).toBeUndefined()
  })

  it('leaves an already-percent utilization alone', () => {
    const windows = mapPushedRateLimitWindows(
      pushInfo({ unifiedWindows: { five_hour: { utilization: 56 } } }),
    )
    expect(windows?.five_hour.utilization).toBe(56)
  })

  it('treats a full window as 100, not 1', () => {
    const windows = mapPushedRateLimitWindows(
      pushInfo({ unifiedWindows: { five_hour: { utilization: 1 } } }),
    )
    expect(windows?.five_hour.utilization).toBe(100)
  })
})

describe('mapUsageToRateLimitWindows', () => {
  it('carries the model name inside the key for dynamic per-model windows', () => {
    const windows = mapUsageToRateLimitWindows(
      usageResponse({
        rate_limits: {
          five_hour: { utilization: 33, resets_at: null },
          model_scoped: [{ display_name: 'Fable', utilization: 4, resets_at: null }],
        },
      } as Partial<SDKControlGetUsageResponse>),
    )
    expect(windows?.['model_scoped:Fable']?.utilization).toBe(4)
  })

  it('returns null when the account reports no plan limits', () => {
    expect(
      mapUsageToRateLimitWindows(
        usageResponse({ rate_limits_available: false, rate_limits: undefined }),
      ),
    ).toBeNull()
  })
})

describe('ClaudeUsageProbe backoff', () => {
  beforeEach(() => {
    // Only Date is faked: the probe's own timing is all `Date.now()`, while
    // `withTimeout` needs a real timer to clear.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T10:00:00Z'))
    queryMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries an empty response instead of giving up permanently', async () => {
    const usage = vi
      .fn()
      .mockResolvedValueOnce(usageResponse({ rate_limits_available: false, rate_limits: undefined }))
      .mockResolvedValue(usageResponse())
    queryMock.mockImplementation(() => fakeQuery(usage))
    const probe = new ClaudeUsageProbe(ctx)

    expect(await probe.get()).toBeNull()
    expect(usage).toHaveBeenCalledTimes(1)

    // Inside the first minute the probe stays quiet — no second CLI process.
    vi.advanceTimersByTime(59_000)
    expect(await probe.get()).toBeNull()
    expect(usage).toHaveBeenCalledTimes(1)

    // Past it, the account is asked again and the badge comes back. The old
    // permanent `unsupported` flag never reached this line.
    vi.advanceTimersByTime(2_000)
    const recovered = await probe.get()
    expect(usage).toHaveBeenCalledTimes(2)
    expect(recovered?.windows.five_hour?.utilization).toBe(33)
    expect(recovered?.subscriptionType).toBe('pro')
  })

  it('doubles the delay while polls keep coming back empty', async () => {
    const usage = vi.fn().mockResolvedValue(usageResponse({ rate_limits_available: false }))
    queryMock.mockImplementation(() => fakeQuery(usage))
    const probe = new ClaudeUsageProbe(ctx)

    await probe.get() // streak 1 → 60s
    vi.advanceTimersByTime(61_000)
    await probe.get() // streak 2 → 120s
    expect(usage).toHaveBeenCalledTimes(2)

    // A minute is no longer enough — the window has doubled.
    vi.advanceTimersByTime(61_000)
    await probe.get()
    expect(usage).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(60_000)
    await probe.get()
    expect(usage).toHaveBeenCalledTimes(3)
  })

  it('caps the delay at an hour', async () => {
    const usage = vi.fn().mockResolvedValue(usageResponse({ rate_limits_available: false }))
    queryMock.mockImplementation(() => fakeQuery(usage))
    const probe = new ClaudeUsageProbe(ctx)

    // Enough failures that an unclamped exponent would push the next attempt
    // past any duration this loop could advance through.
    for (let i = 0; i < 30; i += 1) {
      await probe.get()
      vi.advanceTimersByTime(RETRY_MAX_MS + 1_000)
    }
    expect(usage).toHaveBeenCalledTimes(30)
  })

  it('resets the streak after a good poll', async () => {
    const usage = vi
      .fn()
      .mockResolvedValueOnce(usageResponse({ rate_limits_available: false }))
      .mockResolvedValueOnce(usageResponse())
      .mockResolvedValue(usageResponse({ rate_limits_available: false }))
    queryMock.mockImplementation(() => fakeQuery(usage))
    const probe = new ClaudeUsageProbe(ctx)

    await probe.get() // fail → 60s
    vi.advanceTimersByTime(61_000)
    await probe.get() // success → streak cleared
    await probe.get() // fail again → back to 60s, not 120s
    expect(usage).toHaveBeenCalledTimes(3)

    vi.advanceTimersByTime(61_000)
    await probe.get()
    expect(usage).toHaveBeenCalledTimes(4)
  })

  it('polls straight away when a manual refresh forces past the backoff', async () => {
    const usage = vi
      .fn()
      .mockResolvedValueOnce(usageResponse({ rate_limits_available: false }))
      .mockResolvedValue(usageResponse())
    queryMock.mockImplementation(() => fakeQuery(usage))
    const probe = new ClaudeUsageProbe(ctx)

    expect(await probe.get()).toBeNull() // empty → backing off for a minute
    expect(usage).toHaveBeenCalledTimes(1)

    // An ordinary poll one second later is still suppressed.
    vi.advanceTimersByTime(1_000)
    expect(await probe.get()).toBeNull()
    expect(usage).toHaveBeenCalledTimes(1)

    // The Refresh button is not an ordinary poll: it asks now.
    const forced = await probe.get({ force: true })
    expect(usage).toHaveBeenCalledTimes(2)
    expect(forced?.windows.five_hour?.utilization).toBe(33)
  })

  it('leaves the streak alone when forced, so a held button cannot reset the backoff', async () => {
    const usage = vi.fn().mockResolvedValue(usageResponse({ rate_limits_available: false }))
    queryMock.mockImplementation(() => fakeQuery(usage))
    const probe = new ClaudeUsageProbe(ctx)

    await probe.get() // streak 1 → 60s
    await probe.get({ force: true }) // streak 2 → 120s
    expect(usage).toHaveBeenCalledTimes(2)

    // Had the force reset the streak, this would be past a fresh 60s window
    // and would poll again. The account's own history still sets the pace.
    vi.advanceTimersByTime(61_000)
    await probe.get()
    expect(usage).toHaveBeenCalledTimes(2)
  })

  it('serves the last good snapshot while backing off', async () => {
    const usage = vi
      .fn()
      .mockResolvedValueOnce(usageResponse())
      .mockRejectedValue(new Error('CLI died'))
    queryMock.mockImplementation(() => fakeQuery(usage))
    const probe = new ClaudeUsageProbe(ctx)

    await probe.get()
    const afterFailure = await probe.get()
    // A dead CLI must not blank a badge that is already on screen.
    expect(afterFailure?.windows.five_hour?.utilization).toBe(33)
  })
})
