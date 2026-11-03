import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handle = { url: () => Promise<string>; emit: (frame: unknown) => void; fail: (error: unknown) => void; closed: boolean }
const handles: Handle[] = []

vi.mock('./sse', () => ({
  subscribeSse: ({ url, onEvent, onError }: { url: () => Promise<string>; onEvent: (e: unknown) => void; onError?: (e: unknown) => void }) => {
    const handle: Handle = { url, emit: onEvent, fail: (error) => onError?.(error), closed: false }
    handles.push(handle)
    return { close: () => { handle.closed = true } }
  },
}))
vi.mock('./api', () => ({ api: { eventStreamUrl: async (channels: readonly string[]) => `/events?ch=${channels.join(',')}` } }))

const { subscribeEvents, resetEventStreamForTests } = await import('./event-stream')

const open = () => handles.filter((h) => !h.closed)

beforeEach(() => {
  vi.useFakeTimers()
  handles.length = 0
})
afterEach(() => {
  resetEventStreamForTests()
  vi.useRealTimers()
})

describe('shared event stream', () => {
  it('opens ONE connection for every channel subscribed in the same render', async () => {
    subscribeEvents('inbox', { onEvent: () => {} })
    subscribeEvents('tasks', { onEvent: () => {} })
    subscribeEvents('workflow', { onEvent: () => {} })
    expect(handles).toHaveLength(0)
    vi.runAllTimers()

    expect(open()).toHaveLength(1)
    expect(await open()[0].url()).toBe('/events?ch=inbox,tasks,workflow')
  })

  it('routes each frame to its own channel only', () => {
    const inbox: unknown[] = []
    const tasks: unknown[] = []
    subscribeEvents('inbox', { onEvent: (data) => inbox.push(data) })
    subscribeEvents('tasks', { onEvent: (data) => tasks.push(data) })
    vi.runAllTimers()

    open()[0].emit({ ch: 'inbox', data: { type: 'counts' } })
    open()[0].emit({ ch: 'tasks', data: { type: 'task_upsert' } })
    open()[0].emit({ ch: 'workflow', data: { t: 'sync' } })

    expect(inbox).toEqual([{ type: 'counts' }])
    expect(tasks).toEqual([{ type: 'task_upsert' }])
  })

  it('reconnects with the wider set when a new channel joins later', async () => {
    subscribeEvents('inbox', { onEvent: () => {} })
    vi.runAllTimers()
    subscribeEvents('live-status', { onEvent: () => {} })
    vi.runAllTimers()

    expect(handles[0].closed).toBe(true)
    expect(open()).toHaveLength(1)
    expect(await open()[0].url()).toBe('/events?ch=inbox,live-status')
  })

  it('does not reconnect for another subscriber of a channel already on the wire', () => {
    subscribeEvents('inbox', { onEvent: () => {} })
    vi.runAllTimers()
    subscribeEvents('inbox', { onEvent: () => {} })
    vi.runAllTimers()
    expect(handles).toHaveLength(1)
  })

  it('keeps the connection when one channel leaves, and closes it when the last does', () => {
    const inbox = subscribeEvents('inbox', { onEvent: () => {} })
    const tasks = subscribeEvents('tasks', { onEvent: () => {} })
    vi.runAllTimers()

    inbox.close()
    vi.runAllTimers()
    expect(open()).toHaveLength(1)

    tasks.close()
    vi.runAllTimers()
    expect(open()).toHaveLength(0)
  })

  it('stops delivering to a closed subscriber', () => {
    const seen: unknown[] = []
    const keep = subscribeEvents('inbox', { onEvent: () => {} })
    const gone = subscribeEvents('inbox', { onEvent: (data) => seen.push(data) })
    vi.runAllTimers()
    gone.close()
    open()[0].emit({ ch: 'inbox', data: 1 })
    expect(seen).toEqual([])
    keep.close()
  })

  it('tells every subscriber when the shared connection fails', () => {
    const errors: string[] = []
    subscribeEvents('inbox', { onEvent: () => {}, onError: () => errors.push('inbox') })
    subscribeEvents('live-status', { onEvent: () => {}, onError: () => errors.push('live-status') })
    vi.runAllTimers()
    open()[0].fail(new Error('dropped'))
    expect(errors.sort()).toEqual(['inbox', 'live-status'])
  })
})
