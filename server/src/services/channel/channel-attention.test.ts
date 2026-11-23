import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/** Pending approvals by chat, as the runtime would report them. */
const pendingByChat = new Map<number, Array<{ approvalId: string; toolName: string }>>()
vi.mock('../ai/chat-pending-input.js', () => ({
  listPendingApprovals: (chatId: number) => pendingByChat.get(chatId) ?? [],
}))
vi.mock('../ai.js', () => ({ injectIntoChat: vi.fn(async () => ({ success: true, delivery: 'steered' })) }))

const { SqliteStorage } = await import('../../storage/sqlite.js')
const { getChannelUnreadWithAttention, listChannelUnreadWithAttention } = await import('./channel-attention.js')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operon-channel-attention-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

// better-sqlite3 is built for Electron's Node; under a plain Node it does not load. Run with
// `ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run <this file>` to cover it.
let opened: InstanceType<typeof SqliteStorage> | undefined
try {
  opened = new SqliteStorage(path.join(dir, 'test.db'))
} catch {
  opened = undefined
}
const storage = opened as InstanceType<typeof SqliteStorage>

beforeEach(() => pendingByChat.clear())

let seq = 0
let chatSeq = 7000
function setup() {
  seq += 1
  const project = storage.createProject({ name: `p${seq}`, rootPath: `/p${seq}` })
  const channel = storage.createChannel({ projectId: project.id, name: `general${seq}` })
  const agent = storage.createAgent({ name: `luna${seq}`, provider: 'codex', model: 'gpt' })
  storage.addMember(channel.id, agent.id)
  /** A session with a chat, optionally blocked on an approval. */
  const session = (scopeKind: 'app' | 'thread', scopeKey: string, blocked: boolean) => {
    chatSeq += 1
    const binding = storage.upsertBinding({ agentId: agent.id, scopeKind, scopeKey, projectId: project.id, workspaceId: 100, status: 'idle' })
    storage.updateBinding(binding.id, { activeChatId: chatSeq })
    if (blocked) pendingByChat.set(chatSeq, [{ approvalId: `a${chatSeq}`, toolName: 'Bash' }])
  }
  const post = (senderType: 'human' | 'agent', threadRootId: number | null = null) =>
    storage.createMessage({ channelId: channel.id, threadRootId, senderType, senderId: senderType === 'agent' ? agent.id : null, senderName: senderType, content: 'x' })
  const thread = (status: 'open' | 'waiting' | 'done') => {
    const root = post('human')
    storage.ensureThread({ rootMessageId: root.id, channelId: channel.id, ownerAgentId: agent.id, createdByType: 'human' })
    storage.updateThread(root.id, { status })
    return root
  }
  return { channel, session, post, thread }
}

describe.skipIf(!opened)('channel attention (the amber count)', () => {
  it('counts a channel session blocked on you, and reading does not clear it', () => {
    const { channel, session } = setup()
    session('app', String(channel.id), true)
    storage.markChannelRead(channel.id)
    expect(getChannelUnreadWithAttention(storage, channel.id)).toMatchObject({ unread: 0, attention: 1 })
    expect(listChannelUnreadWithAttention(storage).find((u) => u.channelId === channel.id)?.attention).toBe(1)
  })

  it('counts each blocked thread session once, even if the thread is also waiting', () => {
    const { channel, session, thread, post } = setup()
    const root = thread('waiting')
    post('agent', root.id)
    session('thread', String(root.id), true)
    expect(getChannelUnreadWithAttention(storage, channel.id)?.attention).toBe(1)
  })

  it('counts a waiting thread only while its replies are unread', () => {
    const { channel, thread, post } = setup()
    const root = thread('waiting')
    post('agent', root.id)
    expect(getChannelUnreadWithAttention(storage, channel.id)?.attention).toBe(1)
    storage.markThreadRead(root.id)
    expect(getChannelUnreadWithAttention(storage, channel.id)?.attention).toBe(0)
  })

  it('ignores sessions with nothing pending and threads that are not waiting', () => {
    const { channel, session, thread, post } = setup()
    session('app', String(channel.id), false)
    const root = thread('done')
    post('agent', root.id)
    expect(getChannelUnreadWithAttention(storage, channel.id)?.attention).toBe(0)
    expect(listChannelUnreadWithAttention(storage).find((u) => u.channelId === channel.id)).toMatchObject({ attention: 0, threads: { [root.id]: 1 } })
  })

  it('lists a channel that has attention but nothing unread', () => {
    const { channel, session, thread } = setup()
    const root = thread('open')
    session('thread', String(root.id), true)
    expect(listChannelUnreadWithAttention(storage).find((u) => u.channelId === channel.id)).toEqual({ channelId: channel.id, unread: 0, threads: {}, attention: 1 })
  })
})
