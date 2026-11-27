import { describe, expect, it, vi } from 'vitest'
import { chatHistoryRoutes } from './chat-history.js'

const { getSessionSummary } = vi.hoisted(() => ({ getSessionSummary: vi.fn() }))

vi.mock('../services/operon-runtime/index.js', () => ({
  getOperonHarness: async () => ({ getSessionSummary }),
  loadedOperonSession: () => undefined,
}))

vi.mock('../services/ssh-environments.js', () => ({
  getSshEnvironment: () => ({ cwd: '/home/admin/new-default' }),
}))

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

  it('returns the original work directory of a closed SSH session', async () => {
    getSessionSummary.mockResolvedValueOnce({ workDir: '/home/admin/operon-broker' })
    const sshEnvironment = { id: 'ssh-id', name: 'Tokyo Broker' }
    const sshStorage = {
      ...storage,
      getChatMeta: () => ({
        ...storage.getChatMeta(7)!,
        sessionId: 'persisted-session',
        metadata: { sshEnvironment },
      }),
    }
    const response = await chatHistoryRoutes(sshStorage).request('/7?limit=50')
    expect(await response.json()).toMatchObject({
      sshEnvironment: { ...sshEnvironment, cwd: '/home/admin/operon-broker' },
    })
    expect(getSessionSummary).toHaveBeenCalledWith('persisted-session')
  })
})
