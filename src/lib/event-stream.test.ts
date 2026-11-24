import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handle = {
  url: () => Promise<string>
  headers?: () => Record<string, string>
  emit: (frame: unknown) => void
  fail: (error: unknown) => void
  closed: boolean
}
const handles: Handle[] = []

vi.mock('./sse', () => ({
  subscribeSse: ({ url, headers, onEvent, onError }: {
    url: () => Promise<string>
    headers?: () => Record<string, string>
    onEvent: (e: unknown) => void
    onError?: (e: unknown) => void
  }) => {
    const handle: Handle = { url, headers, emit: onEvent, fail: (error) => onError?.(error), closed: false }
    handles.push(handle)
    return { close: () => { handle.closed = true } }
  },
}))
vi.mock('./api', () => ({
  api: { eventStreamUrl: async (channels: readonly string[]) => `/events?ch=${channels.join(',')}` },
  apiFor: (nodeId: string) => ({
    eventStreamUrl: async (channels: readonly string[]) => `/remote/${nodeId}/events?ch=${channels.join(',')}`,
  }),
}))
vi.mock('./api-client', () => ({
  transportFor: (nodeId: string) => ({ authHeaders: () => ({ Authorization: `Bearer local-for-${nodeId}` }) }),
}))

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

describe('one connection per machine', () => {
  it("opens another machine's channels on their own connection, through the relay", async () => {
    subscribeEvents('live-status', { onEvent: () => {} })
    subscribeEvents('live-status', { onEvent: () => {} }, 'node-b')
    subscribeEvents('external-agents', { onEvent: () => {} }, 'node-b')
    vi.runAllTimers()

    const urls = await Promise.all(open().map((h) => h.url()))
    expect(urls.sort()).toEqual(['/events?ch=live-status', '/remote/node-b/events?ch=external-agents,live-status'])
    const remote = open().find((h) => h.headers)
    expect(remote?.headers?.()).toEqual({ Authorization: 'Bearer local-for-node-b' })
    // This machine's connection keeps its plain shape (no extra headers).
    expect(open().filter((h) => !h.headers)).toHaveLength(1)
  })

  it('delivers a frame only to the machine it came from', async () => {
    const local: unknown[] = []
    const remote: unknown[] = []
    subscribeEvents('live-status', { onEvent: (data) => local.push(data) })
    subscribeEvents('live-status', { onEvent: (data) => remote.push(data) }, 'node-b')
    vi.runAllTimers()

    const remoteHandle = open().find((h) => h.headers)!
    const localHandle = open().find((h) => !h.headers)!
    remoteHandle.emit({ ch: 'live-status', data: 'from b' })
    localHandle.emit({ ch: 'live-status', data: 'from here' })
    expect(local).toEqual(['from here'])
    expect(remote).toEqual(['from b'])
  })

  it("closes a machine's connection when its last listener leaves, without touching this one", () => {
    subscribeEvents('live-status', { onEvent: () => {} })
    const remote = subscribeEvents('live-status', { onEvent: () => {} }, 'node-b')
    vi.runAllTimers()
    expect(open()).toHaveLength(2)

    remote.close()
    vi.runAllTimers()
    expect(open()).toHaveLength(1)
    expect(open()[0].headers).toBeUndefined()

    // Listening again opens a fresh connection to it.
    subscribeEvents('live-status', { onEvent: () => {} }, 'node-b')
    vi.runAllTimers()
    expect(open()).toHaveLength(2)
  })

  it("reports a failure only to that machine's subscribers", () => {
    const errors: string[] = []
    subscribeEvents('live-status', { onEvent: () => {}, onError: () => errors.push('local') })
    subscribeEvents('live-status', { onEvent: () => {}, onError: () => errors.push('remote') }, 'node-b')
    vi.runAllTimers()

    open().find((h) => h.headers)!.fail(new Error('relay down'))
    expect(errors).toEqual(['remote'])
  })
})
