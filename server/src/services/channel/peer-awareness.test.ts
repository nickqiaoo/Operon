import { describe, expect, it, vi } from 'vitest'
import type { AgentBinding } from '../../types/agent-binding.js'
import type { ChannelMessage, MessageSenderType } from '../../types/channel.js'

vi.mock('../ai.js', () => ({ injectIntoChat: vi.fn() }))

const {
  buildPeerNudge,
  describeSenders,
  getFollowUps,
  planRewake,
  selectHeldMessages,
  setFollowUps,
} = await import('./peer-awareness.js')

const PEER = 2

function msg(id: number, senderType: MessageSenderType, senderId: number | null = null, senderName?: string): ChannelMessage {
  return {
    id,
    channelId: 10,
    threadRootId: null,
    senderType,
    senderId,
    senderName: senderName ?? (senderType === 'agent' ? `agent${senderId}` : senderType),
    content: `m${id}`,
    replyCount: 0,
    lastReplyAt: null,
    senderBindingId: null,
    attachments: [],
    createdAt: 0,
  }
}

describe('selectHeldMessages', () => {
  it('holds on an unread peer reply', () => {
    expect(selectHeldMessages([msg(1, 'agent', PEER)]).map((m) => m.id)).toEqual([1])
  })

  it('holds on an unread human message and shows system notices alongside', () => {
    expect(selectHeldMessages([msg(1, 'system'), msg(2, 'human')]).map((m) => m.id)).toEqual([1, 2])
  })

  it('does not hold on system notices alone, or with nothing unread', () => {
    expect(selectHeldMessages([msg(1, 'system')])).toEqual([])
    expect(selectHeldMessages([])).toEqual([])
  })
})

describe('planRewake', () => {
  it('wakes and resets the follow-up count for a human message', () => {
    expect(planRewake([msg(1, 'agent', PEER), msg(2, 'human')], 2)).toEqual({ kind: 'wake', followUp: 0 })
  })

  it('counts agent-only wakes up to the limit, then stops', () => {
    const peerOnly = [msg(1, 'agent', PEER)]
    expect(planRewake(peerOnly, 0, 2)).toEqual({ kind: 'wake', followUp: 1 })
    expect(planRewake(peerOnly, 1, 2)).toEqual({ kind: 'wake', followUp: 2 })
    expect(planRewake(peerOnly, 2, 2)).toEqual({ kind: 'skip', reason: 'follow-up-limit' })
  })

  it('skips when nothing is unread, or only system notices', () => {
    expect(planRewake([], 0)).toEqual({ kind: 'skip', reason: 'nothing-new' })
    expect(planRewake([msg(1, 'system')], 0)).toEqual({ kind: 'skip', reason: 'nothing-new' })
  })
})

describe('follow-up count in binding metadata', () => {
  function fakeStorage(metadata: Record<string, unknown> | null) {
    let binding = { id: 7, metadata } as AgentBinding
    const updateBinding = vi.fn((_id: number, updates: { metadata?: Record<string, unknown> | null }) => {
      binding = { ...binding, metadata: updates.metadata ?? null }
    })
    return { getBinding: () => binding, updateBinding, current: () => binding }
  }

  it('persists the count next to other metadata and clears it at zero', () => {
    const storage = fakeStorage({ other: 'x' })
    setFollowUps(storage, 7, 2)
    expect(getFollowUps(storage, 7)).toBe(2)
    expect(storage.current().metadata).toEqual({ other: 'x', peerFollowUps: 2 })
    setFollowUps(storage, 7, 0)
    expect(storage.current().metadata).toEqual({ other: 'x' })
  })

  it('skips the write when the count is unchanged', () => {
    const storage = fakeStorage(null)
    setFollowUps(storage, 7, 0)
    expect(storage.updateBinding).not.toHaveBeenCalled()
  })
})

describe('nudge text', () => {
  it('names distinct senders, skipping system notices', () => {
    const unread = [msg(1, 'human', null, 'Alice'), msg(2, 'agent', PEER), msg(3, 'agent', PEER), msg(4, 'system')]
    expect(describeSenders(unread)).toBe(' from Alice, agent2')
    expect(describeSenders([msg(1, 'system')])).toBe('')
  })

  it('collapses long sender lists', () => {
    const unread = ['a', 'b', 'c', 'd', 'e'].map((n, i) => msg(i + 1, 'human', null, n))
    expect(describeSenders(unread)).toBe(' from a, b and 3 others')
  })

  it('carries a count, never message content', () => {
    const text = buildPeerNudge(2, '#general', ' from agent2')
    expect(text).toContain('2 new message(s) in #general from agent2')
    expect(text).toContain('check_messages')
  })
})
