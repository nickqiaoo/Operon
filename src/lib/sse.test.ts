import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeSse } from './sse'

/** Builds a Response whose body emits `chunks`, then ends (`done`). */
function sseResponse(chunks: string[], init?: { ok?: boolean; status?: number }) {
  const encoder = new TextEncoder()
  let i = 0
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: 'OK',
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: encoder.encode(chunks[i++]) }
            : { done: true, value: undefined },
      }),
    },
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  // Pin the retry jitter. `scheduleRetry` adds `Math.random() * 500` to every delay, and the
  // backoff assertions below advance the clock past one retry to check that the *next* one has
  // not fired yet. Two jitters accumulate before that check, so with real randomness the timer
  // lands inside the asserted window roughly one run in twelve — green locally, red in CI on no
  // particular commit. The doubling is what these tests are about; the jitter is not.
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Lets queued microtasks run without advancing fake timers. */
// Drains the microtask queue so the subscriber's promise chain can advance. The count is
// generous on purpose: 20 was enough when this file ran alone but not when vitest runs it
// alongside everything else, where the extra scheduling latency leaves the chain a few ticks
// short and the retry under test has not been issued yet when the assertion runs.
const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}

describe('subscribeSse', () => {
  it('parses data: frames into events', async () => {
    fetchMock.mockResolvedValue(sseResponse(['data: {"n":1}\ndata: {"n":2}\n']))
    const events: unknown[] = []

    const sub = subscribeSse<{ n: number }>({
      url: async () => '/stream',
      onEvent: (e) => events.push(e),
    })
    await flush()

    expect(events).toEqual([{ n: 1 }, { n: 2 }])
    sub.close()
  })

  it('reassembles a frame split across chunks', async () => {
    fetchMock.mockResolvedValue(sseResponse(['data: {"n":', '42}\n']))
    const events: unknown[] = []

    const sub = subscribeSse<{ n: number }>({
      url: async () => '/stream',
      onEvent: (e) => events.push(e),
    })
    await flush()

    expect(events).toEqual([{ n: 42 }])
    sub.close()
  })

  // The regression this module was written for: a clean server close arrives as
  // `done`, not as a throw, and the per-hook copies only reconnected from their
  // `catch` — so the stream went silent for good.
  it('reconnects after the server closes the stream cleanly', async () => {
    fetchMock.mockResolvedValue(sseResponse(['data: {"n":1}\n']))

    const sub = subscribeSse({ url: async () => '/stream', onEvent: () => {} })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_600)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    sub.close()
  })

  it('does not feed a non-2xx body to the parser, and retries', async () => {
    const onEvent = vi.fn()
    const onError = vi.fn()
    fetchMock.mockResolvedValue(sseResponse(['<html>502</html>'], { ok: false, status: 502 }))

    const sub = subscribeSse({ url: async () => '/stream', onEvent, onError })
    await flush()

    expect(onEvent).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0][0])).toContain('502')

    await vi.advanceTimersByTimeAsync(1_600)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    sub.close()
  })

  it('backs off exponentially across consecutive short-lived attempts', async () => {
    fetchMock.mockResolvedValue(sseResponse([], { ok: false, status: 500 }))

    const sub = subscribeSse({ url: async () => '/stream', onEvent: () => {} })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // First retry is scheduled at ~1s, the second at ~2s: after 1.6s only one
    // extra attempt has happened.
    await vi.advanceTimersByTimeAsync(1_600)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1_600)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(3)

    sub.close()
  })

  // A tunnel that accepts the connection and then stalls fails *slowly*. The
  // attempt used to be timed from before the fetch, so that latency counted as
  // uptime, every failure looked like a healthy stream dropping, and the delay
  // reset to 1s each time — a retry storm from the code meant to prevent one.
  it('does not count connect latency as uptime when resetting backoff', async () => {
    fetchMock.mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('stalled')), 6_000)),
    )

    const sub = subscribeSse({ url: async () => '/stream', onEvent: () => {}, onError: () => {} })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // First attempt fails after 6s (> HEALTHY_MS); retry is scheduled at ~1s.
    await vi.advanceTimersByTimeAsync(6_000)
    await flush()
    await vi.advanceTimersByTimeAsync(1_600)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // Second attempt fails the same way. The delay must have doubled to ~2s, so
    // 1.6s buys nothing; the old behaviour reset it to 1s and would fire here.
    await vi.advanceTimersByTimeAsync(6_000)
    await flush()
    await vi.advanceTimersByTimeAsync(1_600)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(3)

    sub.close()
  })

  it('parks while the browser is offline and reconnects on `online`', async () => {
    const listeners: Record<string, Array<() => void>> = {}
    const nav = { onLine: false }
    vi.stubGlobal('navigator', nav)
    vi.stubGlobal('window', {
      addEventListener: (type: string, cb: () => void) => void (listeners[type] ??= []).push(cb),
      removeEventListener: (type: string, cb: () => void) => {
        listeners[type] = (listeners[type] ?? []).filter((l) => l !== cb)
      },
    })
    fetchMock.mockResolvedValue(sseResponse(['data: {"n":1}\n']))

    const sub = subscribeSse({ url: async () => '/stream', onEvent: () => {} })
    await flush()

    // Nothing is sent, and nothing is scheduled: a fetch now would fail inside
    // the browser and log a console error for it.
    expect(fetchMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()

    // Network back: reconnect at once rather than sitting out the backoff.
    nav.onLine = true
    for (const cb of listeners.online ?? []) cb()
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    sub.close()
  })

  it('close() stops delivery and cancels a pending reconnect', async () => {
    fetchMock.mockResolvedValue(sseResponse(['data: {"n":1}\n']))
    const onEvent = vi.fn()

    const sub = subscribeSse({ url: async () => '/stream', onEvent })
    await flush()
    expect(onEvent).toHaveBeenCalledTimes(1)

    sub.close()
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()

    // No second attempt: the reconnect timer was cleared by close().
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledTimes(1)
  })

  it('reports a malformed frame without dropping the stream', async () => {
    fetchMock.mockResolvedValue(sseResponse(['data: not-json\ndata: {"n":7}\n']))
    const onParseError = vi.fn()
    const events: unknown[] = []

    const sub = subscribeSse<{ n: number }>({
      url: async () => '/stream',
      onEvent: (e) => events.push(e),
      onParseError,
    })
    await flush()

    expect(onParseError).toHaveBeenCalledTimes(1)
    expect(events).toEqual([{ n: 7 }])
    sub.close()
  })
})
