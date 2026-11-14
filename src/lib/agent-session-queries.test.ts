import { describe, expect, it } from 'vitest'
import { foldResourceState } from './agent-session-queries'

const NO_SESSION = 'No active session'

type QueryState = Parameters<typeof foldResourceState>[0]

/** A fresh query's first fetch, unless a test overrides it. */
const state = (overrides: Partial<QueryState> = {}): QueryState => ({
  data: undefined,
  error: null,
  status: 'pending',
  fetchStatus: 'fetching',
  errorUpdateCount: 0,
  ...overrides,
})

const failed = state({ status: 'error', fetchStatus: 'idle', error: new Error(NO_SESSION), errorUpdateCount: 1 })
// What v5 turns `failed` into while a background poll is in flight: no data, so
// the fetch resets `status` to pending and clears `error`.
const pollTick = state({ errorUpdateCount: 1 })
const succeeded = state({ data: { servers: [] }, status: 'success', fetchStatus: 'idle', errorUpdateCount: 1 })

describe('foldResourceState', () => {
  it('shows loading on the first fetch', () => {
    expect(foldResourceState(state(), null, false)).toEqual({ error: null, loading: true, settled: false })
  })

  it('settles with the error when the fetch fails', () => {
    expect(foldResourceState(failed, null, false)).toEqual({ error: NO_SESSION, loading: false, settled: true })
  })

  it('holds the error through a background poll of a data-less failed query', () => {
    expect(foldResourceState(pollTick, NO_SESSION, false)).toEqual({ error: NO_SESSION, loading: false, settled: true })
  })

  it('clears the held error once data arrives', () => {
    expect(foldResourceState(succeeded, NO_SESSION, false)).toEqual({ error: null, loading: false, settled: true })
  })

  it('starts clean when a fresh query takes the slot (chat/provider switch)', () => {
    expect(foldResourceState(state(), NO_SESSION, false)).toEqual({ error: null, loading: true, settled: false })
  })

  it('counts an explicit reload as loading', () => {
    expect(foldResourceState(failed, null, true).loading).toBe(true)
  })

  it('keeps a no-session panel stable across poll ticks until the session starts', () => {
    // The flash: error → in-flight tick (v5 clears the error) → error again.
    // The held error must survive every tick, then clear when the first
    // message starts the session and a poll succeeds.
    let held: string | null = null
    const step = (query: QueryState) => {
      const folded = foldResourceState(query, held, false)
      held = folded.error
      return folded
    }
    expect(step(failed).error).toBe(NO_SESSION)
    for (let i = 0; i < 3; i++) {
      expect(step(pollTick)).toEqual({ error: NO_SESSION, loading: false, settled: true })
      expect(step(failed)).toEqual({ error: NO_SESSION, loading: false, settled: true })
    }
    expect(step(succeeded)).toEqual({ error: null, loading: false, settled: true })
  })
})
