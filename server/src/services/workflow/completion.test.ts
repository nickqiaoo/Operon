import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getChatMeta: vi.fn(), handleChat: vi.fn() }))

vi.mock('../ai/chat-flow.js', () => ({ handleChat: mocks.handleChat }))
vi.mock('../ai/state.js', () => ({
  getChatHistoryService: () => ({ getChatMeta: mocks.getChatMeta }),
  getChatStorage: () => ({ getChatMeta: mocks.getChatMeta }),
}))
vi.mock('../ai/live-turn-hub.js', () => ({ getLiveTurnStatus: () => ({ active: false }), subscribeLiveTurnPresence: () => () => {} }))
vi.mock('./store.js', () => ({ readRunResult: vi.fn() }))

import { deliverChatNotice, setAssistantSpecNoticeSink } from './completion.js'

describe('deliverChatNotice', () => {
  afterEach(() => {
    setAssistantSpecNoticeSink(undefined)
    vi.clearAllMocks()
  })

  it("hands a notice for the assistant's spec to the assistant, and runs no turn", async () => {
    mocks.getChatMeta.mockReturnValue({ metadata: { assistantSpec: { projectId: 5 } } })
    const sink = vi.fn()
    setAssistantSpecNoticeSink(sink)
    expect(await deliverChatNotice(40, 'design ready', {}, 'r1')).toBe(true)
    expect(sink).toHaveBeenCalledWith({ projectId: 5, text: 'design ready' })
    expect(mocks.handleChat).not.toHaveBeenCalled()
  })

  it('reports it undelivered when the assistant is not running', async () => {
    mocks.getChatMeta.mockReturnValue({ metadata: { assistantSpec: { projectId: 5 } } })
    expect(await deliverChatNotice(40, 'design ready', {}, 'r1')).toBe(false)
    expect(mocks.handleChat).not.toHaveBeenCalled()
  })

  it('still runs a turn in an ordinary conversation', async () => {
    mocks.getChatMeta.mockReturnValue({ providerId: 'codex', metadata: {} })
    mocks.handleChat.mockResolvedValue({ body: null })
    const sink = vi.fn()
    setAssistantSpecNoticeSink(sink)
    expect(await deliverChatNotice(41, 'design ready', {}, 'r1')).toBe(true)
    expect(mocks.handleChat).toHaveBeenCalledTimes(1)
    expect(sink).not.toHaveBeenCalled()
  })
})
