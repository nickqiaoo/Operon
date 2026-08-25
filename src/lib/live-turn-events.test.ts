import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mocked rather than driven through fetch: what matters here is the fan-out from
// one stream to per-chat listeners, not SSE framing (covered in sse.test.ts).
const sseHandles: Array<{
  emit: (frame: unknown) => void
  fail: () => void
  closed: boolean
}> = []

vi.mock('./sse.js', () => ({
  subscribeSse: ({ onEvent, onError }: { onEvent: (e: unknown) => void; onError?: () => void }) => {
    const handle = { emit: onEvent, fail: () => onError?.(), closed: false }
    sseHandles.push(handle)
    return { close: () => { handle.closed = true } }
  },
}))

vi.mock('./api', () => ({ api: { aiLiveStatusStreamUrl: async () => '/stream' } }))

const { subscribeChatPresence } = await import('./live-turn-events')

type Status = { chatId: number; active: boolean; turnId: string | null; startedAt: number | null }
const running = (chatId: number, turnId = 't1'): Status => ({ chatId, active: true, turnId, startedAt: 1 })

beforeEach(() => {
  sseHandles.length = 0
})

const live = () => sseHandles.filter((h) => !h.closed)

describe('subscribeChatPresence', () => {
  it('answers immediately with idle, matching the snapshot the per-chat stream used to send', () => {
    const seen: Status[] = []
    const off = subscribeChatPresence(77, { onStatus: (s) => seen.push(s) })

    expect(seen).toEqual([{ chatId: 77, active: false, turnId: null, startedAt: null }])
    off()
  })

  it('opens ONE stream no matter how many chats are watched', () => {
    const offA = subscribeChatPresence(1, { onStatus: () => {} })
    const offB = subscribeChatPresence(2, { onStatus: () => {} })
    const offC = subscribeChatPresence(3, { onStatus: () => {} })

    expect(live()).toHaveLength(1)
    offA(); offB(); offC()
  })

  it('routes an event only to the chat it names', () => {
    const a: Status[] = []
    const b: Status[] = []
    const offA = subscribeChatPresence(10, { onStatus: (s) => a.push(s) })
    const offB = subscribeChatPresence(20, { onStatus: (s) => b.push(s) })
    a.length = 0
    b.length = 0

    live()[0].emit({ type: 'presence', status: running(10) })

    expect(a).toEqual([running(10)])
    expect(b).toEqual([])
    offA(); offB()
  })

  it('gives a chat subscribed later the turn it missed, without asking the server', () => {
    const first = subscribeChatPresence(30, { onStatus: () => {} })
    live()[0].emit({ type: 'sync', statuses: [running(31, 'inflight')] })

    const seen: Status[] = []
    const second = subscribeChatPresence(31, { onStatus: (s) => seen.push(s) })

    // The old design got this from connecting; here it comes from the cached sync.
    expect(seen).toEqual([running(31, 'inflight')])
    first(); second()
  })

  it('reports a turn that ended while the stream was down', () => {
    const seen: Status[] = []
    const off = subscribeChatPresence(40, { onStatus: (s) => seen.push(s) })
    live()[0].emit({ type: 'sync', statuses: [running(40)] })
    expect(seen.at(-1)).toEqual(running(40))

    // Reconnect: 40 is gone from the snapshot, so it must be reported idle rather
    // than left showing a turn that is over.
    live()[0].emit({ type: 'sync', statuses: [] })

    expect(seen.at(-1)).toEqual({ chatId: 40, active: false, turnId: null, startedAt: null })
    off()
  })

  it('closes the stream once nothing is watching, and reopens on the next subscribe', () => {
    const off = subscribeChatPresence(50, { onStatus: () => {} })
    expect(live()).toHaveLength(1)

    off()
    expect(live()).toHaveLength(0)

    const again = subscribeChatPresence(50, { onStatus: () => {} })
    expect(live()).toHaveLength(1)
    again()
  })

  it('tells every watcher when the stream errors', () => {
    let aFailed = false
    let bFailed = false
    const offA = subscribeChatPresence(60, { onStatus: () => {}, onError: () => { aFailed = true } })
    const offB = subscribeChatPresence(61, { onStatus: () => {}, onError: () => { bFailed = true } })

    live()[0].fail()

    expect(aFailed).toBe(true)
    expect(bFailed).toBe(true)
    offA(); offB()
  })
})
