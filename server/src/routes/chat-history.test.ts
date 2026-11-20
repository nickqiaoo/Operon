import { describe, expect, it } from 'vitest'
import { chatHistoryRoutes } from './chat-history.js'

type Storage = Parameters<typeof chatHistoryRoutes>[0]

const storage = {
  getChatMessages: () => ({ messages: [], total: 0, hasMore: false, nextCursor: undefined }),
  getChatMeta: () => ({
    id: 7,
    model: 'opus',
    providerId: 'claude-code',
    thinkingLevel: 'high',
    updatedAt: 1,
    metadata: { modeId: 'auto' },
  }),
} as unknown as Storage

describe('GET /chat-history/:chatId', () => {
  it('returns the mode the chat last ran in, so it reopens in it', async () => {
    const response = await chatHistoryRoutes(storage).request('/7?limit=50')
    expect(await response.json()).toMatchObject({ providerId: 'claude-code', thinkingLevel: 'high', modeId: 'auto' })
  })
})
