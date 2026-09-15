import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import type { ChatInjectionResult } from './ai/session-ops.js'
import { beginChatTurn, emitChatTurnFinished, markChatTurnReady } from './ai/chat-turn-lifecycle.js'
import { clearExternalAgentNotifications, enqueueExternalAgentResult } from './external-agent-notifications.js'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(), handleChat: vi.fn(), inject: vi.fn(),
}))
vi.mock('./ai/state.js', () => ({
  getChatStorage: () => ({
    getChatMeta: () => ({ providerId: 'fake', model: 'model', metadata: {} }),
    getChatEntry: () => ({ messages: [{ id: 'owner', role: 'user', parts: [] }] }),
  }),
  getSessionManager: () => ({ get: mocks.getSession }),
}))
vi.mock('./ai/chat-flow.js', () => ({ handleChat: mocks.handleChat }))
vi.mock('./ai/session-ops.js', () => ({ injectIntoChat: mocks.inject }))

const chatId = 910
const message = (id: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text: `Result ${id}` }] })
const finish = () => emitChatTurnFinished({ chatId, turnId: 'parent', status: 'completed' })
const activeSession = () => ({ activeRequest: { requestId: 'parent' }, runtime: { injectMessage: vi.fn() } })
const tick = () => vi.advanceTimersByTimeAsync(100)

describe('external result notification inbox', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.getSession.mockReset()
    mocks.handleChat.mockReset().mockImplementation(async () => new Response())
    mocks.inject.mockReset().mockResolvedValue({ success: true, delivery: 'accepted' })
  })
  afterEach(() => {
    clearExternalAgentNotifications()
    finish()
    vi.useRealTimers()
  })

  it('waits without polling for a non-steer parent and starts one turn for all three results', async () => {
    beginChatTurn(chatId, 'parent')
    markChatTurnReady(chatId, 'parent')
    mocks.getSession.mockReturnValue({ activeRequest: { requestId: 'parent' }, runtime: {} })
    for (const id of ['A', 'B', 'C']) enqueueExternalAgentResult(chatId, message(id))
    await tick()
    expect(mocks.handleChat).not.toHaveBeenCalled()
    expect(mocks.inject).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    mocks.getSession.mockReturnValue(undefined)
    finish()
    await tick()
    expect(mocks.handleChat).toHaveBeenCalledTimes(1)
    expect(mocks.handleChat.mock.calls[0][0].messages[0].parts[0].text).toBe('Result A\n\nResult B\n\nResult C')
    expect(mocks.handleChat.mock.calls[0][2]).toEqual({ onlyIfIdle: true })
  })

  it('steers a batch, and delivers arrivals during injection without waiting for the parent to finish', async () => {
    beginChatTurn(chatId, 'parent')
    markChatTurnReady(chatId, 'parent')
    mocks.getSession.mockReturnValue(activeSession())
    let accept!: (result: ChatInjectionResult) => void
    mocks.inject.mockImplementationOnce(() => new Promise<ChatInjectionResult>((resolve) => { accept = resolve }))
    enqueueExternalAgentResult(chatId, message('A'))
    enqueueExternalAgentResult(chatId, message('B'))
    await tick()
    enqueueExternalAgentResult(chatId, message('A')) // Duplicate while A is in flight.
    enqueueExternalAgentResult(chatId, message('C'))
    await tick()
    expect(mocks.inject).toHaveBeenCalledTimes(1)
    accept({ success: true, delivery: 'accepted' })
    await tick()
    expect(mocks.inject).toHaveBeenCalledTimes(2)
    expect(mocks.inject.mock.calls[1][1]).toBe('Result C')
    expect(mocks.handleChat).not.toHaveBeenCalled()
    expect(mocks.inject.mock.calls[0][3].expectedRequestId).toBe('parent')
  })

  it('defers through setup, then wakes on ready rather than dropping the notification', async () => {
    beginChatTurn(chatId, 'parent')
    enqueueExternalAgentResult(chatId, message('A'))
    await tick()
    expect(mocks.inject).not.toHaveBeenCalled()
    mocks.getSession.mockReturnValue(activeSession())
    markChatTurnReady(chatId, 'parent')
    await tick()
    expect(mocks.inject).toHaveBeenCalledTimes(1)
  })

  it('retries a definite pre-injection rejection after a racing parent completion', async () => {
    beginChatTurn(chatId, 'parent')
    markChatTurnReady(chatId, 'parent')
    mocks.getSession.mockReturnValue(activeSession())
    mocks.inject.mockImplementationOnce(async () => {
      mocks.getSession.mockReturnValue(undefined)
      finish()
      return { success: false, delivery: 'not-sent' }
    })
    enqueueExternalAgentResult(chatId, message('A'))
    await tick()
    await tick()
    expect(mocks.handleChat).toHaveBeenCalledTimes(1)
  })

  it.each(['accepted', 'unknown'] as const)('does not resend an unsuccessful %s injection', async (delivery) => {
    beginChatTurn(chatId, 'parent')
    markChatTurnReady(chatId, 'parent')
    mocks.getSession.mockReturnValue(activeSession())
    mocks.inject.mockResolvedValue({ success: false, delivery, error: 'failure' })
    enqueueExternalAgentResult(chatId, message('A'))
    await tick()
    mocks.getSession.mockReturnValue(undefined)
    finish()
    await tick()
    expect(mocks.inject).toHaveBeenCalledTimes(1)
    expect(mocks.handleChat).not.toHaveBeenCalled()
  })

  it('keeps the batch when a user wins startup admission and then steers it', async () => {
    mocks.handleChat.mockImplementationOnce(async () => {
      beginChatTurn(chatId, 'parent')
      mocks.getSession.mockReturnValue(activeSession())
      markChatTurnReady(chatId, 'parent')
      return new Response(null, { status: 409 })
    })
    enqueueExternalAgentResult(chatId, message('A'))
    await tick()
    await tick()
    expect(mocks.handleChat).toHaveBeenCalledTimes(1)
    expect(mocks.inject).toHaveBeenCalledTimes(1)
    expect(mocks.inject.mock.calls[0][1]).toBe('Result A')
  })
})
