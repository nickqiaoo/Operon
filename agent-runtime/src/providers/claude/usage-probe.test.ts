import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk'

// `vi.mock` is hoisted above this file's own statements, so the spy it closes
// over has to be hoisted with it.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}))

vi.mock('../../host.js', () => ({
  getRuntimeHost: () => ({
    resolveCliPath: () => '/usr/local/bin/claude',
    getShellEnv: () => ({}),
    getUserEnv: () => ({}),
  }),
}))

const { ClaudeUsageProbe, mapUsageToRateLimitWindows } = await import('./usage-probe.js')

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
    const probe = new ClaudeUsageProbe()

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
    const probe = new ClaudeUsageProbe()

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
    const probe = new ClaudeUsageProbe()

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
    const probe = new ClaudeUsageProbe()

    await probe.get() // fail → 60s
    vi.advanceTimersByTime(61_000)
    await probe.get() // success → streak cleared
    await probe.get() // fail again → back to 60s, not 120s
    expect(usage).toHaveBeenCalledTimes(3)

    vi.advanceTimersByTime(61_000)
    await probe.get()
    expect(usage).toHaveBeenCalledTimes(4)
  })

  it('serves the last good snapshot while backing off', async () => {
    const usage = vi
      .fn()
      .mockResolvedValueOnce(usageResponse())
      .mockRejectedValue(new Error('CLI died'))
    queryMock.mockImplementation(() => fakeQuery(usage))
    const probe = new ClaudeUsageProbe()

    await probe.get()
    const afterFailure = await probe.get()
    // A dead CLI must not blank a badge that is already on screen.
    expect(afterFailure?.windows.five_hour?.utilization).toBe(33)
  })
})
