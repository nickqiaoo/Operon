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
    expect(channel).toBe('chat-status')
    const handle = { nodeId, emit: onEvent, fail: () => onError?.(), closed: false }
    sseHandles.push(handle)
    return { close: () => { handle.closed = true } }
  },
}))

const { subscribeChatTurnStatus, watchChatStatus } = await import('./chat-status-events')
const { useChatPendingInputStore } = await import('@/stores/chat-pending-input-store')
const { useChatRunningStore } = await import('@/stores/chat-running-store')
const { useChatBackgroundTaskStore } = await import('@/stores/chat-background-task-store')
const { useChatPromptSuggestionStore } = await import('@/stores/chat-prompt-suggestion-store')
const { chatKey } = await import('./chat-ref')

type Status = { chatId: number; active: boolean; turnId: string | null; startedAt: number | null }
const running = (chatId: number, turnId = 't1'): Status => ({ chatId, active: true, turnId, startedAt: 1 })
/** A `sync` frame: the whole picture, every list present. */
const sync = (frame: { turns: Status[]; pendingInput?: unknown[]; backgroundTasks?: unknown[]; promptSuggestions?: unknown[] }) => ({
  type: 'sync',
  pendingInput: [],
  backgroundTasks: [],
  promptSuggestions: [],
  ...frame,
})

beforeEach(() => {
  sseHandles.length = 0
})

const open = () => sseHandles.filter((h) => !h.closed)
const streamOn = (nodeId: string | undefined) => {
  const handle = open().find((h) => h.nodeId === nodeId)
  if (!handle) throw new Error(`no open stream for ${nodeId ?? 'this machine'}`)
  return handle
}

describe('subscribeChatTurnStatus', () => {
  it('answers immediately with idle, matching the snapshot the per-chat stream used to send', () => {
    const seen: Status[] = []
    const off = subscribeChatTurnStatus({ chatId: 77 }, { onStatus: (s) => seen.push(s) })

    expect(seen).toEqual([{ chatId: 77, active: false, turnId: null, startedAt: null }])
    off()
  })

  it('opens ONE stream no matter how many chats are watched', () => {
    const offA = subscribeChatTurnStatus({ chatId: 1 }, { onStatus: () => {} })
    const offB = subscribeChatTurnStatus({ chatId: 2 }, { onStatus: () => {} })
    const offC = subscribeChatTurnStatus({ chatId: 3 }, { onStatus: () => {} })

    expect(open()).toHaveLength(1)
    offA(); offB(); offC()
  })

  it('routes an event only to the chat it names', () => {
    const a: Status[] = []
    const b: Status[] = []
    const offA = subscribeChatTurnStatus({ chatId: 10 }, { onStatus: (s) => a.push(s) })
    const offB = subscribeChatTurnStatus({ chatId: 20 }, { onStatus: (s) => b.push(s) })
    a.length = 0
    b.length = 0

    open()[0].emit({ type: 'turn', status: running(10) })

    expect(a).toEqual([running(10)])
    expect(b).toEqual([])
    offA(); offB()
  })

  it('gives a chat subscribed later the turn it missed, without asking the server', () => {
    const first = subscribeChatTurnStatus({ chatId: 30 }, { onStatus: () => {} })
    open()[0].emit(sync({ turns: [running(31, 'inflight')] }))

    const seen: Status[] = []
    const second = subscribeChatTurnStatus({ chatId: 31 }, { onStatus: (s) => seen.push(s) })

    // The old design got this from connecting; here it comes from the cached sync.
    expect(seen).toEqual([running(31, 'inflight')])
    first(); second()
  })

  it('reports a turn that ended while the stream was down', () => {
    const seen: Status[] = []
    const off = subscribeChatTurnStatus({ chatId: 40 }, { onStatus: (s) => seen.push(s) })
    open()[0].emit(sync({ turns: [running(40)] }))
    expect(seen.at(-1)).toEqual(running(40))

    // Reconnect: 40 is gone from the snapshot, so it must be reported idle rather
    // than left showing a turn that is over.
    open()[0].emit(sync({ turns: [] }))

    expect(seen.at(-1)).toEqual({ chatId: 40, active: false, turnId: null, startedAt: null })
    off()
  })

  it('closes the stream once nothing is watching, and reopens on the next subscribe', () => {
    const off = subscribeChatTurnStatus({ chatId: 50 }, { onStatus: () => {} })
    expect(open()).toHaveLength(1)

    off()
    expect(open()).toHaveLength(0)

    const again = subscribeChatTurnStatus({ chatId: 50 }, { onStatus: () => {} })
    expect(open()).toHaveLength(1)
    again()
  })

  it('tells every watcher when the stream errors', () => {
    let aFailed = false
    let bFailed = false
    const offA = subscribeChatTurnStatus({ chatId: 60 }, { onStatus: () => {}, onError: () => { aFailed = true } })
    const offB = subscribeChatTurnStatus({ chatId: 61 }, { onStatus: () => {}, onError: () => { bFailed = true } })

    open()[0].fail()

    expect(aFailed).toBe(true)
    expect(bFailed).toBe(true)
    offA(); offB()
  })
})

describe('watchChatStatus', () => {
  const ask = (approvalId: string) => ({ approvalId, toolName: 'Bash', requestedAt: 1, userFacing: true })
  const pendingOf = (chatId: number) => useChatPendingInputStore.getState().pendingByChat.get(chatKey({ chatId }))

  it('mirrors every chat\'s pending input and holds the shared stream open', () => {
    const release = watchChatStatus()
    const offChat = subscribeChatTurnStatus({ chatId: 50 }, { onStatus: () => {} })
    expect(open()).toHaveLength(1)

    open()[0].emit(sync({ turns: [], pendingInput: [{ chatId: 51, pending: [ask('a')] }, { chatId: 52, pending: [] }] }))
    expect(pendingOf(51)).toEqual([ask('a')])
    expect(pendingOf(52)).toBeUndefined()

    open()[0].emit({ type: 'pending-input', chatId: 53, pending: [ask('b'), ask('c')] })
    open()[0].emit({ type: 'pending-input', chatId: 51, pending: [] })
    expect(pendingOf(51)).toBeUndefined()
    expect(pendingOf(53)).toHaveLength(2)

    // A chat panel going away does not close the stream the tab markers need.
    offChat()
    expect(open()).toHaveLength(1)

    release()
    expect(open()).toHaveLength(0)
    expect(useChatPendingInputStore.getState().pendingByChat.size).toBe(0)
  })

  it('treats a sync from an older server as nothing pending', () => {
    const release = watchChatStatus()
    open()[0].emit({ type: 'pending-input', chatId: 60, pending: [ask('a')] })
    open()[0].emit(sync({ turns: [] }))
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
    const offLocal = subscribeChatTurnStatus({ chatId: 5 }, { onStatus: (s) => local.push(s) })
    const offRemote = subscribeChatTurnStatus({ nodeId: NODE, chatId: 5 }, { onStatus: (s) => remote.push(s) })
    expect(open().map((h) => h.nodeId)).toEqual([undefined, NODE])
    local.length = 0
    remote.length = 0

    streamOn(NODE).emit({ type: 'turn', status: running(5) })
    expect(remote.map((s) => s.active)).toEqual([true])
    expect(local).toEqual([])
    const running5 = useChatRunningStore.getState().runningChats
    expect(running5.has(chatKey({ nodeId: NODE, chatId: 5 }))).toBe(true)
    expect(running5.has(chatKey({ chatId: 5 }))).toBe(false)

    offLocal()
    offRemote()
  })

  it("writes a machine's sync into the stores without touching the other machine's entries", () => {
    const releaseLocal = watchChatStatus()
    const releaseRemote = watchChatStatus(NODE)
    streamOn(undefined).emit(sync({
      turns: [running(1)],
      pendingInput: [{ chatId: 1, pending: [ask('local')] }],
      backgroundTasks: [{ chatId: 1, tasks: [task('local')] }],
      promptSuggestions: [{ chatId: 1, text: 'local next' }],
    }))
    streamOn(NODE).emit(sync({
      turns: [running(1)],
      pendingInput: [{ chatId: 1, pending: [ask('remote')] }],
      backgroundTasks: [{ chatId: 1, tasks: [task('remote')] }],
      promptSuggestions: [{ chatId: 1, text: 'remote next' }],
    }))

    const here = chatKey({ chatId: 1 })
    const there = chatKey({ nodeId: NODE, chatId: 1 })
    expect(useChatPendingInputStore.getState().pendingByChat.get(here)).toEqual([ask('local')])
    expect(useChatPendingInputStore.getState().pendingByChat.get(there)).toEqual([ask('remote')])
    expect(useChatBackgroundTaskStore.getState().tasksByChat.get(there)).toEqual([task('remote')])
    expect(useChatPromptSuggestionStore.getState().suggestionByChat.get(here)).toBe('local next')

    // The other machine's next sync empties only its own entries.
    streamOn(NODE).emit(sync({ turns: [] }))
    expect(useChatPendingInputStore.getState().pendingByChat.has(there)).toBe(false)
    expect(useChatPendingInputStore.getState().pendingByChat.get(here)).toEqual([ask('local')])
    expect(useChatRunningStore.getState().runningChats.has(here)).toBe(true)
    expect(useChatBackgroundTaskStore.getState().tasksByChat.has(here)).toBe(true)
    expect(useChatPromptSuggestionStore.getState().suggestionByChat.has(there)).toBe(false)

    releaseRemote()
    releaseLocal()
  })

  it("forgets a machine's chats when nothing watches it any more, and leaves this machine's", () => {
    const releaseLocal = watchChatStatus()
    const releaseRemote = watchChatStatus(NODE)
    streamOn(undefined).emit({ type: 'pending-input', chatId: 2, pending: [ask('a')] })
    streamOn(NODE).emit({ type: 'pending-input', chatId: 2, pending: [ask('b')] })
    streamOn(NODE).emit({ type: 'turn', status: running(3) })

    releaseRemote()
    expect(open().map((h) => h.nodeId)).toEqual([undefined])
    const pending = useChatPendingInputStore.getState().pendingByChat
    expect(pending.has(chatKey({ nodeId: NODE, chatId: 2 }))).toBe(false)
    expect(pending.get(chatKey({ chatId: 2 }))).toEqual([ask('a')])
    expect(useChatRunningStore.getState().runningChats.has(chatKey({ nodeId: NODE, chatId: 3 }))).toBe(false)

    releaseLocal()
  })

  it("starts a re-watched machine from its own fresh snapshot", () => {
    const first = watchChatStatus(NODE)
    const chat: Status[] = []
    streamOn(NODE).emit({ type: 'turn', status: running(4) })
    first()

    const second = watchChatStatus(NODE)
    const off = subscribeChatTurnStatus({ nodeId: NODE, chatId: 4 }, { onStatus: (s) => chat.push(s) })
    // The old snapshot was dropped with the stream: idle until the new sync says otherwise.
    expect(chat.map((s) => s.active)).toEqual([false])
    streamOn(NODE).emit(sync({ turns: [running(4)] }))
    expect(chat.map((s) => s.active)).toEqual([false, true])
    off()
    second()
  })
})
