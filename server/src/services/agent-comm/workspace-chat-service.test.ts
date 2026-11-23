import { describe, expect, it, vi } from 'vitest'
import type { ChannelMessage } from '../../types/channel.js'

vi.mock('../ai.js', () => ({ injectIntoChat: vi.fn() }))

const { WorkspaceChatService } = await import('./workspace-chat-service.js')

const AGENT = 5

function human(id: number, channelId: number): ChannelMessage {
  return {
    id, channelId, threadRootId: null, senderType: 'human', senderId: null, senderName: 'you',
    content: `m${id}`, replyCount: 0, lastReplyAt: null, senderBindingId: null, attachments: [], createdAt: 0,
  }
}

/** Two channels (#a=1, #b=2) the agent is in, each with an active session and one unread human message. */
function fakeStorage() {
  const channels = [{ id: 1, name: 'a', projectId: 3 }, { id: 2, name: 'b', projectId: 3 }]
  const messages = [human(10, 1), human(11, 2)]
  const cursors = new Map<number, number>()
  let nextId = 100
  const storage = {
    listChannels: () => channels,
    listMembers: () => [{ agentId: AGENT }],
    getUnreadChannelMessages: (_agentId: number, channelId: number) =>
      messages.filter((m) => m.channelId === channelId && m.id > (cursors.get(channelId) ?? 0) && m.senderId !== AGENT),
    upsertCursor: (_a: number, _k: string, key: string, id: number) =>
      cursors.set(Number(key), Math.max(cursors.get(Number(key)) ?? 0, id)),
    getBindingByScope: () => ({ status: 'active' }),
    listBindingsForScope: () => [],
    getAgent: () => ({ name: 'luna-dev' }),
    createMessage: (input: Omit<ChannelMessage, 'id'>) => {
      const m = { ...human(nextId++, input.channelId), ...input }
      messages.push(m)
      return m
    },
  }
  return { storage, cursors }
}

describe('WorkspaceChatService scoped to its session channel', () => {
  it("check_messages reads only the session's channel", async () => {
    const { storage, cursors } = fakeStorage()
    const service = new WorkspaceChatService(storage as never, 3, 1)
    const lines = await service.checkMessages(AGENT)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('target=#a')
    expect(cursors.get(2)).toBeUndefined()
  })

  it("posting into another channel neither holds nor marks that channel's messages read", async () => {
    const { storage, cursors } = fakeStorage()
    const service = new WorkspaceChatService(storage as never, 3, 1)
    const result = await service.sendMessage({ target: '#b', content: 'fyi', agentId: AGENT })
    expect(result.status).toBe('sent')
    expect(cursors.get(2)).toBeUndefined()
  })

  it('posting into its own channel with unread messages is held', async () => {
    const { storage, cursors } = fakeStorage()
    const service = new WorkspaceChatService(storage as never, 3, 1)
    const result = await service.sendMessage({ target: '#a', content: 'hi', agentId: AGENT })
    expect(result.status).toBe('held')
    expect(cursors.get(1)).toBe(10)
  })
})
