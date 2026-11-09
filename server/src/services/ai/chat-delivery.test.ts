import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { beginChatTurn, emitChatTurnFinished, markChatTurnReady, abortManagedChatTurn } from './chat-turn-lifecycle.js'
import { deliverChatMessage } from './chat-delivery.js'
const mocks = vi.hoisted(() => ({ session: vi.fn(), chat: vi.fn(), inject: vi.fn() }))
vi.mock('./state.js', () => ({ getSessionManager: () => ({ get: mocks.session }), getChatStorage: () => ({ getChatMeta: () => ({}), getChatEntry: () => ({ messages: [{ id: 'owner', role: 'user', parts: [] }] }) }) }))
vi.mock('./chat-flow.js', () => ({ handleChat: mocks.chat }))
vi.mock('./session-ops.js', () => ({ injectIntoChat: mocks.inject }))
const chatId = 911
const message: UIMessage = { id: 'follow-up', role: 'user', parts: [{ type: 'text', text: 'follow-up' }], metadata: { externalAgentDispatch: true } }
const finish = () => emitChatTurnFinished({ chatId, turnId: 'running', status: 'completed' })
const active = (steer = true) => ({ activeRequest: { requestId: 'running' }, runtime: steer ? { steer() {} } : { followup() {} } })
describe('chat delivery delegates scheduling to runtime', () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.inject.mockResolvedValue({ success: true, delivery: 'accepted' }); mocks.chat.mockResolvedValue(new Response(null)) })
  afterEach(finish)
  it.each([true, false])('selects steer when available, otherwise native followup: %s', async (steer) => {
    mocks.session.mockReturnValue(active(steer))
    expect((await deliverChatMessage(chatId, message)).delivery).toBe(steer ? 'injected' : 'followup')
    expect(mocks.inject).toHaveBeenCalledWith(chatId, 'follow-up', 'owner', { message, expectedRequestId: 'running', mode: steer ? 'steer' : 'followup' })
    expect(mocks.chat).not.toHaveBeenCalled()
  })
  it('honors explicit followup even on steer-capable providers', async () => {
    mocks.session.mockReturnValue({ ...active(), runtime: { steer() {}, followup() {} } })
    await deliverChatMessage(chatId, message, message.id, 'followup')
    expect(mocks.inject.mock.calls[0][3].mode).toBe('followup')
  })
  it('rejects unavailable capabilities without a host fallback queue', async () => {
    mocks.session.mockReturnValue({ ...active(), runtime: {} })
    await expect(deliverChatMessage(chatId, message)).rejects.toThrow('does not support followup')
    finish(); expect(mocks.chat).not.toHaveBeenCalled()
  })
  it('starts idle chats', async () => {
    expect((await deliverChatMessage(chatId, message)).delivery).toBe('started')
    expect(mocks.chat).toHaveBeenCalledOnce()
  })
  it('waits only for startup admission, then steers', async () => {
    beginChatTurn(chatId, 'running')
    const pending = deliverChatMessage(chatId, message)
    expect(mocks.inject).not.toHaveBeenCalled()
    mocks.session.mockReturnValue(active()); markChatTurnReady(chatId, 'running')
    expect((await pending).delivery).toBe('injected')
  })
  it('does not start after an admission wait is cancelled', async () => {
    beginChatTurn(chatId, 'running')
    const pending = deliverChatMessage(chatId, message)
    abortManagedChatTurn(chatId)
    expect((await pending).delivery).toBe('cancelled')
    expect(mocks.chat).not.toHaveBeenCalled()
  })
  it.each(['unknown', 'accepted'])('never resends %s failures', async (delivery) => {
    mocks.session.mockReturnValue(active())
    mocks.inject.mockResolvedValue({ success: false, delivery, error: 'response lost' })
    expect((await deliverChatMessage(chatId, message)).delivery).toBe(delivery)
    finish(); expect(mocks.chat).not.toHaveBeenCalled()
  })
  it('starts once after a definite rejection races with completion', async () => {
    mocks.session.mockReturnValue(active())
    mocks.inject.mockImplementationOnce(async () => { mocks.session.mockReturnValue(undefined); return { success: false, delivery: 'not-sent' } })
    expect((await deliverChatMessage(chatId, message)).delivery).toBe('started')
    expect(mocks.chat).toHaveBeenCalledOnce()
  })
})

describe('definite startup steer rejection', () => {
  afterEach(finish)
  it('uses runtime followup only for an explicit rejection, without starting a second request', async () => {
    vi.resetAllMocks()
    mocks.session.mockReturnValue({ ...active(), runtime: { steer() {}, followup() {} } })
    mocks.inject.mockResolvedValueOnce({ success: false, delivery: 'not-sent' }).mockResolvedValueOnce({ success: true, delivery: 'accepted' })
    expect((await deliverChatMessage(chatId, message)).delivery).toBe('followup')
    expect(mocks.inject.mock.calls.map((call) => call[3].mode)).toEqual(['steer', 'followup'])
    expect(mocks.chat).not.toHaveBeenCalled()
  })
})
