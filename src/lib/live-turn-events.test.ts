import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mocked rather than driven through fetch: what matters here is the fan-out from
// one stream to per-chat listeners, not SSE framing (covered in sse.test.ts).
const sseHandles: Array<{
  nodeId: string | undefined
  emit: (frame: unknown) => void
  fail: () => void
  closed: boolean
}> = []

vi.mock('./event-stream', () => ({
  subscribeEvents: (channel: string, { onEvent, onError }: { onEvent: (e: unknown) => void; onError?: () => void }, nodeId?: string) => {
    expect(channel).toBe('live-status')
    const handle = { nodeId, emit: onEvent, fail: () => onError?.(), closed: false }
    sseHandles.push(handle)
    return { close: () => { handle.closed = true } }
  },
}))

const { subscribeChatPresence, watchPendingInput } = await import('./live-turn-events')
const { useChatPendingInputStore } = await import('@/stores/chat-pending-input-store')
const { useChatPresenceStore } = await import('@/stores/chat-presence-store')
const { useChatBackgroundTaskStore } = await import('@/stores/chat-background-task-store')
const { useChatPromptSuggestionStore } = await import('@/stores/chat-prompt-suggestion-store')
const { chatKey } = await import('./chat-ref')

type Status = { chatId: number; active: boolean; turnId: string | null; startedAt: number | null }
const running = (chatId: number, turnId = 't1'): Status => ({ chatId, active: true, turnId, startedAt: 1 })

beforeEach(() => {
  sseHandles.length = 0
})

const live = () => sseHandles.filter((h) => !h.closed)
const liveOn = (nodeId: string | undefined) => {
  const handle = live().find((h) => h.nodeId === nodeId)
  if (!handle) throw new Error(`no live stream for ${nodeId ?? 'this machine'}`)
  return handle
}

describe('subscribeChatPresence', () => {
  it('answers immediately with idle, matching the snapshot the per-chat stream used to send', () => {
    const seen: Status[] = []
    const off = subscribeChatPresence({ chatId: 77 }, { onStatus: (s) => seen.push(s) })

    expect(seen).toEqual([{ chatId: 77, active: false, turnId: null, startedAt: null }])
    off()
  })

  it('opens ONE stream no matter how many chats are watched', () => {
    const offA = subscribeChatPresence({ chatId: 1 }, { onStatus: () => {} })
    const offB = subscribeChatPresence({ chatId: 2 }, { onStatus: () => {} })
    const offC = subscribeChatPresence({ chatId: 3 }, { onStatus: () => {} })

    expect(live()).toHaveLength(1)
    offA(); offB(); offC()
  })

  it('routes an event only to the chat it names', () => {
    const a: Status[] = []
    const b: Status[] = []
    const offA = subscribeChatPresence({ chatId: 10 }, { onStatus: (s) => a.push(s) })
    const offB = subscribeChatPresence({ chatId: 20 }, { onStatus: (s) => b.push(s) })
    a.length = 0
    b.length = 0

    live()[0].emit({ type: 'presence', status: running(10) })

    expect(a).toEqual([running(10)])
    expect(b).toEqual([])
    offA(); offB()
  })

  it('gives a chat subscribed later the turn it missed, without asking the server', () => {
    const first = subscribeChatPresence({ chatId: 30 }, { onStatus: () => {} })
    live()[0].emit({ type: 'sync', statuses: [running(31, 'inflight')] })

    const seen: Status[] = []
    const second = subscribeChatPresence({ chatId: 31 }, { onStatus: (s) => seen.push(s) })

    // The old design got this from connecting; here it comes from the cached sync.
    expect(seen).toEqual([running(31, 'inflight')])
    first(); second()
  })

  it('reports a turn that ended while the stream was down', () => {
    const seen: Status[] = []
    const off = subscribeChatPresence({ chatId: 40 }, { onStatus: (s) => seen.push(s) })
    live()[0].emit({ type: 'sync', statuses: [running(40)] })
    expect(seen.at(-1)).toEqual(running(40))

    // Reconnect: 40 is gone from the snapshot, so it must be reported idle rather
    // than left showing a turn that is over.
    live()[0].emit({ type: 'sync', statuses: [] })

    expect(seen.at(-1)).toEqual({ chatId: 40, active: false, turnId: null, startedAt: null })
    off()
  })

  it('closes the stream once nothing is watching, and reopens on the next subscribe', () => {
    const off = subscribeChatPresence({ chatId: 50 }, { onStatus: () => {} })
    expect(live()).toHaveLength(1)

    off()
    expect(live()).toHaveLength(0)

    const again = subscribeChatPresence({ chatId: 50 }, { onStatus: () => {} })
    expect(live()).toHaveLength(1)
    again()
  })

  it('tells every watcher when the stream errors', () => {
    let aFailed = false
    let bFailed = false
    const offA = subscribeChatPresence({ chatId: 60 }, { onStatus: () => {}, onError: () => { aFailed = true } })
    const offB = subscribeChatPresence({ chatId: 61 }, { onStatus: () => {}, onError: () => { bFailed = true } })

    live()[0].fail()

    expect(aFailed).toBe(true)
    expect(bFailed).toBe(true)
    offA(); offB()
  })
})

describe('watchPendingInput', () => {
  const ask = (approvalId: string) => ({ approvalId, toolName: 'Bash', requestedAt: 1, userFacing: true })
  const pendingOf = (chatId: number) => useChatPendingInputStore.getState().pendingByChat.get(chatKey({ chatId }))

  it('mirrors every chat\'s pending input and holds the shared stream open', () => {
    const release = watchPendingInput()
    const offChat = subscribeChatPresence({ chatId: 50 }, { onStatus: () => {} })
    expect(live()).toHaveLength(1)

    live()[0].emit({ type: 'sync', statuses: [], pendingInput: [{ chatId: 51, pending: [ask('a')] }, { chatId: 52, pending: [] }] })
    expect(pendingOf(51)).toEqual([ask('a')])
    expect(pendingOf(52)).toBeUndefined()

    live()[0].emit({ type: 'pending-input', chatId: 53, pending: [ask('b'), ask('c')] })
    live()[0].emit({ type: 'pending-input', chatId: 51, pending: [] })
    expect(pendingOf(51)).toBeUndefined()
    expect(pendingOf(53)).toHaveLength(2)

    // A chat panel going away does not close the stream the tab markers need.
    offChat()
    expect(live()).toHaveLength(1)

    release()
    expect(live()).toHaveLength(0)
    expect(useChatPendingInputStore.getState().pendingByChat.size).toBe(0)
  })

  it('treats a sync from an older server as nothing pending', () => {
    const release = watchPendingInput()
    live()[0].emit({ type: 'pending-input', chatId: 60, pending: [ask('a')] })
    live()[0].emit({ type: 'sync', statuses: [] })
    expect(pendingOf(60)).toBeUndefined()
    release()
  })
})

describe('several machines', () => {
  const NODE = 'node-b'
  const ask = (approvalId: string) => ({ approvalId, toolName: 'Bash', requestedAt: 1, userFacing: true })
  const task = (id: string) => ({ id, description: id, status: 'running' })

  it("keeps the same chat id on two machines apart", () => {
    const local: Status[] = []
    const remote: Status[] = []
    const offLocal = subscribeChatPresence({ chatId: 5 }, { onStatus: (s) => local.push(s) })
    const offRemote = subscribeChatPresence({ nodeId: NODE, chatId: 5 }, { onStatus: (s) => remote.push(s) })
    expect(live().map((h) => h.nodeId)).toEqual([undefined, NODE])
    local.length = 0
    remote.length = 0

    liveOn(NODE).emit({ type: 'presence', status: running(5) })
    expect(remote.map((s) => s.active)).toEqual([true])
    expect(local).toEqual([])
    const running5 = useChatPresenceStore.getState().runningChats
    expect(running5.has(chatKey({ nodeId: NODE, chatId: 5 }))).toBe(true)
    expect(running5.has(chatKey({ chatId: 5 }))).toBe(false)

    offLocal()
    offRemote()
  })

  it("writes a machine's sync into the stores without touching the other machine's entries", () => {
    const releaseLocal = watchPendingInput()
    const releaseRemote = watchPendingInput(NODE)
    liveOn(undefined).emit({
      type: 'sync',
      statuses: [running(1)],
      pendingInput: [{ chatId: 1, pending: [ask('local')] }],
      backgroundTasks: [{ chatId: 1, tasks: [task('local')] }],
      promptSuggestions: [{ chatId: 1, text: 'local next' }],
    })
    liveOn(NODE).emit({
      type: 'sync',
      statuses: [running(1)],
      pendingInput: [{ chatId: 1, pending: [ask('remote')] }],
      backgroundTasks: [{ chatId: 1, tasks: [task('remote')] }],
      promptSuggestions: [{ chatId: 1, text: 'remote next' }],
    })

    const here = chatKey({ chatId: 1 })
    const there = chatKey({ nodeId: NODE, chatId: 1 })
    expect(useChatPendingInputStore.getState().pendingByChat.get(here)).toEqual([ask('local')])
    expect(useChatPendingInputStore.getState().pendingByChat.get(there)).toEqual([ask('remote')])
    expect(useChatBackgroundTaskStore.getState().tasksByChat.get(there)).toEqual([task('remote')])
    expect(useChatPromptSuggestionStore.getState().suggestionByChat.get(here)).toBe('local next')

    // The other machine's next sync empties only its own entries.
    liveOn(NODE).emit({ type: 'sync', statuses: [] })
    expect(useChatPendingInputStore.getState().pendingByChat.has(there)).toBe(false)
    expect(useChatPendingInputStore.getState().pendingByChat.get(here)).toEqual([ask('local')])
    expect(useChatPresenceStore.getState().runningChats.has(here)).toBe(true)
    expect(useChatBackgroundTaskStore.getState().tasksByChat.has(here)).toBe(true)
    expect(useChatPromptSuggestionStore.getState().suggestionByChat.has(there)).toBe(false)

    releaseRemote()
    releaseLocal()
  })

  it("forgets a machine's chats when nothing watches it any more, and leaves this machine's", () => {
    const releaseLocal = watchPendingInput()
    const releaseRemote = watchPendingInput(NODE)
    liveOn(undefined).emit({ type: 'pending-input', chatId: 2, pending: [ask('a')] })
    liveOn(NODE).emit({ type: 'pending-input', chatId: 2, pending: [ask('b')] })
    liveOn(NODE).emit({ type: 'presence', status: running(3) })

    releaseRemote()
    expect(live().map((h) => h.nodeId)).toEqual([undefined])
    const pending = useChatPendingInputStore.getState().pendingByChat
    expect(pending.has(chatKey({ nodeId: NODE, chatId: 2 }))).toBe(false)
    expect(pending.get(chatKey({ chatId: 2 }))).toEqual([ask('a')])
    expect(useChatPresenceStore.getState().runningChats.has(chatKey({ nodeId: NODE, chatId: 3 }))).toBe(false)

    releaseLocal()
  })

  it("starts a re-watched machine from its own fresh snapshot", () => {
    const first = watchPendingInput(NODE)
    const chat: Status[] = []
    liveOn(NODE).emit({ type: 'presence', status: running(4) })
    first()

    const second = watchPendingInput(NODE)
    const off = subscribeChatPresence({ nodeId: NODE, chatId: 4 }, { onStatus: (s) => chat.push(s) })
    // The old snapshot was dropped with the stream: idle until the new sync says otherwise.
    expect(chat.map((s) => s.active)).toEqual([false])
    liveOn(NODE).emit({ type: 'sync', statuses: [running(4)] })
    expect(chat.map((s) => s.active)).toEqual([false, true])
    off()
    second()
  })
})
