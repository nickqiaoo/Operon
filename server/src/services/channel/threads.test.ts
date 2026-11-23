import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBinding } from '../../types/agent-binding.js'
import type { ChannelMessage } from '../../types/channel.js'

vi.mock('../ai.js', () => ({ injectIntoChat: vi.fn(async () => ({ success: true, delivery: 'steered' })) }))
/** Pending approvals by chat, as the runtime would report them. */
const pendingByChat = new Map<number, Array<{ approvalId: string; toolName: string }>>()
vi.mock('../ai/chat-pending-input.js', () => ({
  listPendingApprovals: (chatId: number) => pendingByChat.get(chatId) ?? [],
}))

const { SqliteStorage } = await import('../../storage/sqlite.js')
const { WorkspaceChatService } = await import('../agent-comm/workspace-chat-service.js')
const { toShortId } = await import('../agent-comm/channel-message-format.js')
const { channelSessionsWaiting, ensureThreadForHumanReply, registerThreadDelivery, removeThreadMember, routeThreadMessage, threadView } = await import('./threads.js')
const { MAX_AGENT_FOLLOW_UPS, setFollowUps } = await import('./peer-awareness.js')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operon-threads-'))
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

/** What the registered delivery was asked to do. */
const toThread: AgentBinding[] = []
const toChannel: ChannelMessage[] = []
const toChannelSession: AgentBinding[] = []

beforeEach(() => {
  toThread.length = 0
  toChannel.length = 0
  toChannelSession.length = 0
  registerThreadDelivery({
    toThreadSession: async (b) => {
      toThread.push(b)
    },
    toChannelSessions: async (_channelId, m) => {
      toChannel.push(m)
    },
    toChannelSession: async (b) => {
      toChannelSession.push(b)
    },
  })
})

let seq = 0
/** A channel with two member agents, each with a channel session in a shared workspace. */
function setup() {
  seq += 1
  const project = storage.createProject({ name: `p${seq}`, rootPath: `/p${seq}` })
  const channel = storage.createChannel({ projectId: project.id, name: `general${seq}` })
  const alice = storage.createAgent({ name: `alice${seq}`, provider: 'claude-code', model: 'sonnet' })
  const bob = storage.createAgent({ name: `bob${seq}`, provider: 'codex', model: 'gpt' })
  for (const a of [alice, bob]) {
    storage.addMember(channel.id, a.id)
    storage.upsertBinding({
      agentId: a.id, scopeKind: 'app', scopeKey: String(channel.id), projectId: project.id,
      workspaceId: 100 + a.id, status: 'idle',
    })
  }
  const human = (content: string, threadRootId: number | null = null) =>
    storage.createMessage({ channelId: channel.id, threadRootId, senderType: 'human', senderName: 'you', content })
  const channelSession = (agentId: number) => storage.getBindingByScope('app', String(channel.id), agentId)!
  const service = new WorkspaceChatService(storage, project.id, channel.id)
  const threadService = (rootId: number) => new WorkspaceChatService(storage, project.id, channel.id, rootId)
  return { project, channel, alice, bob, human, channelSession, service, threadService }
}

describe.skipIf(!opened)('channel threads', () => {
  it('open_thread claims the thread, posts the brief and hands it to a thread session in the shared workspace', async () => {
    const { channel, alice, human, service } = setup()
    const root = human('the build is flaky, can someone look?')

    const result = await service.openThread({ agentId: alice.id, message: toShortId(root.id), brief: 'Looking into the flaky build.' })
    expect(result).toMatchObject({ status: 'opened', owner: alice.name })

    expect(storage.getThread(root.id)?.ownerAgentId).toBe(alice.id)
    const replies = storage.listThreadReplies(root.id)
    expect(replies.map((m) => m.content)).toEqual(['Looking into the flaky build.'])
    // Posted by the channel session, so it is unread for the thread session.
    expect(replies[0].senderBindingId).toBe(storage.getBindingByScope('app', String(channel.id), alice.id)!.id)

    await vi.waitFor(() => expect(toThread).toHaveLength(1))
    const session = toThread[0]
    expect(session).toMatchObject({ scopeKind: 'thread', scopeKey: String(root.id), agentId: alice.id })
    // Shared with its channel session, but kept on its own binding.
    expect(session.workspaceId).toBe(100 + alice.id)
    expect(storage.getUnreadThreadMessages(alice.id, root.id).map((m) => m.content)).toEqual(['Looking into the flaky build.'])
  })

  it("the brief reaches the opener's own thread session even before it has a channel session", async () => {
    const { project, channel, human } = setup()
    const carol = storage.createAgent({ name: `carol${seq}`, provider: 'claude-code', model: 'sonnet' })
    storage.addMember(channel.id, carol.id)
    const root = human('q')
    await new WorkspaceChatService(storage, project.id, channel.id)
      .openThread({ agentId: carol.id, message: toShortId(root.id), brief: 'Taking this.' })
    expect(storage.getBindingByScope('app', String(channel.id), carol.id)).not.toBeNull()
    expect(storage.getUnreadThreadMessages(carol.id, root.id).map((m) => m.content)).toEqual(['Taking this.'])
  })

  it('one thread per message: a second agent is told who owns it and nothing is posted', async () => {
    const { alice, bob, human, service } = setup()
    const root = human('help')
    await service.openThread({ agentId: alice.id, message: toShortId(root.id), brief: 'On it.' })
    const second = await service.openThread({ agentId: bob.id, message: toShortId(root.id), brief: 'Me too.' })
    // The one that didn't get it sees the owner's brief, so it can tell whether it has anything to add.
    expect(second).toMatchObject({ status: 'taken', owner: alice.name, latest: [{ sender: alice.name, content: 'On it.' }] })
    expect(storage.listThreadReplies(root.id)).toHaveLength(1)
  })

  it("a late open_thread for a thread its owner is already working posts nothing and doesn't reopen it", async () => {
    const { alice, bob, human, service } = setup()
    const root = human('q')
    await service.openThread({ agentId: alice.id, message: toShortId(root.id), brief: 'On it.', agent: bob.name })
    await vi.waitFor(() => expect(toThread).toHaveLength(1))
    storage.updateThread(root.id, { status: 'done' })
    toThread.length = 0
    const late = await service.openThread({ agentId: alice.id, message: toShortId(root.id), brief: 'On it (again).', agent: bob.name })
    expect(late).toMatchObject({ status: 'exists', owner: bob.name })
    expect(storage.listThreadReplies(root.id)).toHaveLength(1)
    expect(storage.getThread(root.id)?.status).toBe('done')
    await new Promise((r) => setTimeout(r, 20))
    expect(toThread).toHaveLength(0)
  })

  it('handing a thread to an agent that already took it itself posts no second brief', async () => {
    // A message @-ing alice asks for bob to own the work; bob's channel session
    // opens the thread itself before alice gets to it. Alice's late hand-off
    // must not land a "please take this" brief under bob's finished replies.
    const { alice, bob, human, service } = setup()
    const root = human('@alice I want bob to own this one, in a thread')
    await service.openThread({ agentId: bob.id, message: toShortId(root.id), brief: "I'll look into it." })
    await vi.waitFor(() => expect(toThread).toHaveLength(1))
    toThread.length = 0
    const late = await service.openThread({ agentId: alice.id, message: toShortId(root.id), brief: '@bob please take this.', agent: bob.name })
    expect(late).toMatchObject({ status: 'exists', owner: bob.name })
    expect(storage.listThreadReplies(root.id).map((m) => m.content)).toEqual(["I'll look into it."])
    await new Promise((r) => setTimeout(r, 20))
    expect(toThread).toHaveLength(0)
  })

  it('reports which channel and thread sessions are waiting on an approval', async () => {
    const { channel, alice, bob, human, service, channelSession } = setup()
    const root = human('q')
    await service.openThread({ agentId: alice.id, message: toShortId(root.id), brief: 'b' })
    const aliceThread = storage.getBindingByScope('thread', String(root.id), alice.id)!
    storage.updateBinding(aliceThread.id, { activeChatId: 9001 })
    storage.updateBinding(channelSession(bob.id).id, { activeChatId: 9002 })
    pendingByChat.set(9001, [{ approvalId: 'a1', toolName: 'Bash' }])
    pendingByChat.set(9002, [{ approvalId: 'b1', toolName: 'Write' }])

    expect(threadView(storage, storage.getThread(root.id)!).waiting).toEqual([{ agentId: alice.id, chatId: 9001, approvalIds: ['a1'] }])
    expect(channelSessionsWaiting(storage, channel.id)).toEqual([{ agentId: bob.id, chatId: 9002, approvalIds: ['b1'] }])
    pendingByChat.clear()
  })

  it('can hand the thread to another member', async () => {
    const { alice, bob, human, service } = setup()
    const root = human('needs codex')
    await service.openThread({ agentId: alice.id, message: toShortId(root.id), brief: 'Bob knows this one.', agent: bob.name })
    expect(storage.getThread(root.id)?.ownerAgentId).toBe(bob.id)
    await vi.waitFor(() => expect(toThread.map((b) => b.agentId)).toEqual([bob.id]))
  })

  it('rejects roots that are replies, system notices or in another channel', async () => {
    const { project, alice, human, service } = setup()
    const other = storage.createChannel({ projectId: project.id, name: `other${seq}` })
    storage.addMember(other.id, alice.id)
    const root = human('q')
    const reply = human('a reply', root.id)
    const notice = storage.createMessage({ channelId: root.channelId, senderType: 'system', senderName: 'system', content: 'x joined' })
    const foreign = storage.createMessage({ channelId: other.id, senderType: 'human', senderName: 'you', content: 'elsewhere' })
    await expect(service.openThread({ agentId: alice.id, message: toShortId(reply.id), brief: 'b' })).rejects.toThrow(/nested/)
    await expect(service.openThread({ agentId: alice.id, message: toShortId(notice.id), brief: 'b' })).rejects.toThrow(/system/)
    await expect(service.openThread({ agentId: alice.id, message: toShortId(foreign.id), brief: 'b' })).rejects.toThrow(/No such message/)
    // A root from one channel under another channel's name.
    await expect(service.sendMessage({ agentId: alice.id, target: `#${other.name}:${toShortId(root.id)}`, content: 'x' }))
      .rejects.toThrow(/No such message/)
  })

  it('a thread session cannot open threads, and a channel session cannot report on one', async () => {
    const { alice, human, service, threadService } = setup()
    const root = human('q')
    await service.openThread({ agentId: alice.id, message: toShortId(root.id), brief: 'b' })
    await expect(threadService(root.id).openThread({ agentId: alice.id, message: toShortId(root.id), brief: 'b' })).rejects.toThrow(/nested/)
    await expect(service.updateThread({ agentId: alice.id, status: 'done' })).rejects.toThrow(/thread sessions/)
  })

  it("keeps each session's stream apart: owned threads stay out of the channel session", async () => {
    const { channel, alice, bob, human, service } = setup()
    const owned = human('owned')
    await service.openThread({ agentId: alice.id, message: toShortId(owned.id), brief: 'mine' })
    storage.upsertCursor(alice.id, 'app', String(channel.id), owned.id)
    storage.upsertCursor(bob.id, 'app', String(channel.id), owned.id)

    const inOwned = human('detail for alice', owned.id)
    const unowned = human('unowned root')
    const inUnowned = human('reply nobody owns', unowned.id)

    const forBob = storage.getUnreadChannelMessages(bob.id, channel.id).map((m) => m.id)
    expect(forBob).toEqual([unowned.id, inUnowned.id])
    expect(forBob).not.toContain(inOwned.id)
    expect(storage.getUnreadThreadMessages(alice.id, owned.id).map((m) => m.content)).toEqual(['mine', 'detail for alice'])
  })

  it("a thread session's report reaches its own channel session, and wakes nobody", async () => {
    const { channel, alice, human, service, threadService } = setup()
    const root = human('fix it')
    await service.openThread({ agentId: alice.id, message: toShortId(root.id), brief: 'Fixing.' })
    storage.upsertCursor(alice.id, 'app', String(channel.id), root.id)
    toThread.length = 0

    const result = await threadService(root.id).updateThread({
      agentId: alice.id, status: 'done', summary: 'Fixed the race', channelMessage: 'Fixed — see the thread.',
    })
    expect(result.status).toBe('done')
    expect(storage.getThread(root.id)).toMatchObject({ status: 'done', summary: 'Fixed the race' })
    // The same agent, another session: unread for its channel session.
    expect(storage.getUnreadChannelMessages(alice.id, channel.id).map((m) => m.content)).toEqual(['Fixed — see the thread.'])
    expect(toThread).toHaveLength(0)
    expect(toChannel).toHaveLength(0)
    expect(toChannelSession).toHaveLength(0)
  })

  it('only the owner reports on a thread', async () => {
    const { alice, bob, human, service, threadService } = setup()
    const root = human('q')
    await service.openThread({ agentId: alice.id, message: toShortId(root.id), brief: 'b' })
    await expect(threadService(root.id).updateThread({ agentId: bob.id, status: 'done' })).rejects.toThrow(/owner/)
  })

  it('a human reply goes to the owner and reopens a finished thread', async () => {
    const { channel, alice, human, service } = setup()
    const root = human('q')
    await service.openThread({ agentId: alice.id, message: toShortId(root.id), brief: 'b' })
    storage.updateThread(root.id, { status: 'done' })
    toThread.length = 0

    const reply = human('one more thing', root.id)
    await routeThreadMessage(storage, channel, reply)
    expect(storage.getThread(root.id)?.status).toBe('open')
    expect(toThread.map((b) => b.agentId)).toEqual([alice.id])
    expect(toChannel).toHaveLength(0)
  })

  it('a human reply with an @mention goes to that member, and claims a thread nobody owns', async () => {
    const { channel, bob, human } = setup()
    const root = human('q')
    ensureThreadForHumanReply(storage, root)
    const reply = human(`@${bob.name} can you take this?`, root.id)
    await routeThreadMessage(storage, channel, reply)
    expect(storage.getThread(root.id)?.ownerAgentId).toBe(bob.id)
    expect(toThread.map((b) => b.agentId)).toEqual([bob.id])
  })

  it('a member brought in with an @mention hears later replies, like a channel member', async () => {
    const { channel, alice, bob, human, service } = setup()
    const root = human('q')
    await service.openThread({ agentId: alice.id, message: toShortId(root.id), brief: 'b' })
    await vi.waitFor(() => expect(toThread).toHaveLength(1))
    toThread.length = 0

    // The mention brings bob in; he is asked, so he goes first, and the owner hears it too.
    await routeThreadMessage(storage, channel, human(`@${bob.name} can you look at the tests?`, root.id))
    expect(toThread.map((b) => b.agentId)).toEqual([bob.id, alice.id])
    expect(threadView(storage, storage.getThread(root.id)!).participantAgentIds.sort()).toEqual([alice.id, bob.id].sort())
    toThread.length = 0

    // A reply naming nobody reaches both members.
    await routeThreadMessage(storage, channel, human('what do you both think?', root.id))
    expect(toThread.map((b) => b.agentId)).toEqual([alice.id, bob.id])
    expect(toChannel).toHaveLength(0)
  })

  it('a member taken out of a thread stops hearing it until mentioned again', async () => {
    const { channel, alice, bob, human, service } = setup()
    const root = human('q')
    await service.openThread({ agentId: alice.id, message: toShortId(root.id), brief: 'b' })
    await routeThreadMessage(storage, channel, human(`@${bob.name} join us`, root.id))
    toThread.length = 0

    const stopped: number[] = []
    expect(await removeThreadMember(storage, root.id, bob.id, async (b) => { stopped.push(b.agentId) })).toBe(true)
    expect(stopped).toEqual([bob.id])
    expect(storage.getBindingByScope('thread', String(root.id), bob.id)).toBeNull()

    await routeThreadMessage(storage, channel, human('carry on', root.id))
    expect(toThread.map((b) => b.agentId)).toEqual([alice.id])
    toThread.length = 0

    await routeThreadMessage(storage, channel, human(`@${bob.name} one more`, root.id))
    expect(toThread.map((b) => b.agentId)).toEqual([bob.id, alice.id])
  })

  it('taking the owner out leaves the thread to nobody, and its other members still hear it', async () => {
    const { channel, alice, bob, human, service } = setup()
    const root = human('q')
    await service.openThread({ agentId: alice.id, message: toShortId(root.id), brief: 'b' })
    await routeThreadMessage(storage, channel, human(`@${bob.name} join us`, root.id))
    toThread.length = 0

    await removeThreadMember(storage, root.id, alice.id, async () => {})
    expect(storage.getThread(root.id)?.ownerAgentId).toBeNull()
    await routeThreadMessage(storage, channel, human('still there?', root.id))
    expect(toThread.map((b) => b.agentId)).toEqual([bob.id])
    expect(toChannel).toHaveLength(0)
    expect(await removeThreadMember(storage, root.id, alice.id, async () => {})).toBe(false)
  })

  it('a reply in a thread nobody owns goes to the channel sessions', async () => {
    const { channel, human } = setup()
    const root = human('q')
    ensureThreadForHumanReply(storage, root)
    const reply = human('anyone?', root.id)
    await routeThreadMessage(storage, channel, reply)
    expect(toThread).toHaveLength(0)
    expect(toChannel.map((m) => m.id)).toEqual([reply.id])
  })

  it("replying under an agent's message makes that agent the thread's owner", () => {
    const { channel, bob } = setup()
    const answer = storage.createMessage({ channelId: channel.id, senderType: 'agent', senderId: bob.id, senderName: bob.name, content: 'answer' })
    expect(ensureThreadForHumanReply(storage, answer).ownerAgentId).toBe(bob.id)
  })

  it('a channel session passing something on reaches the owner without counting as a follow-up', async () => {
    const { alice, bob, human, service } = setup()
    const root = human('q')
    await service.openThread({ agentId: alice.id, message: toShortId(root.id), brief: 'b' })
    await vi.waitFor(() => expect(toThread).toHaveLength(1))
    toThread.length = 0
    for (let i = 0; i < 4; i++) {
      await service.sendMessage({ agentId: bob.id, target: `#${storage.getChannel(root.channelId)!.name}:${toShortId(root.id)}`, content: `fyi ${i}`, force: true })
    }
    await vi.waitFor(() => expect(toThread.map((b) => b.agentId)).toEqual([alice.id, alice.id, alice.id, alice.id]))
  })

  it('agents mentioning each other inside a thread are bounded', async () => {
    const { channel, alice, bob, human, service, threadService } = setup()
    const root = human('q')
    await service.openThread({ agentId: alice.id, message: toShortId(root.id), brief: 'b' })
    await vi.waitFor(() => expect(toThread).toHaveLength(1))
    // Give alice's thread session a running state so its posts count as its own.
    const aliceThread = storage.getBindingByScope('thread', String(root.id), alice.id)!
    storage.updateBinding(aliceThread.id, { status: 'active', activeChatId: 999 })
    toThread.length = 0
    const target = `#${channel.name}:${toShortId(root.id)}`
    for (let i = 0; i < MAX_AGENT_FOLLOW_UPS + 3; i++) {
      await threadService(root.id).sendMessage({ agentId: alice.id, target, content: `@${bob.name} ping ${i}`, force: true })
    }
    await new Promise((r) => setTimeout(r, 20))
    expect(toThread.filter((b) => b.agentId === bob.id)).toHaveLength(MAX_AGENT_FOLLOW_UPS)
  })

  it("an agent's @mention in the main channel wakes that member's channel session, and nobody else", async () => {
    const { channel, alice, bob, service } = setup()
    const carol = storage.createAgent({ name: `carol${seq}`, provider: 'claude-code', model: 'sonnet' })
    storage.addMember(channel.id, carol.id)
    await service.sendMessage({ agentId: alice.id, target: `#${channel.name}`, content: `@${bob.name} can you take a look?` })
    await vi.waitFor(() => expect(toChannelSession).toHaveLength(1))
    expect(toChannelSession[0]).toMatchObject({ agentId: bob.id, scopeKind: 'app', scopeKey: String(channel.id) })
    // Without a mention an agent's message still wakes nobody.
    await service.sendMessage({ agentId: alice.id, target: `#${channel.name}`, content: 'noted', force: true })
    await new Promise((r) => setTimeout(r, 20))
    expect(toChannelSession).toHaveLength(1)
    expect(toChannel).toHaveLength(0)
  })

  it('main-channel mentions between agents are bounded, and a human speaking resets the count', async () => {
    const { channel, alice, bob, channelSession, service } = setup()
    for (let i = 0; i < MAX_AGENT_FOLLOW_UPS + 3; i++) {
      await service.sendMessage({ agentId: alice.id, target: `#${channel.name}`, content: `@${bob.name} ping ${i}`, force: true })
    }
    await new Promise((r) => setTimeout(r, 20))
    expect(toChannelSession.filter((b) => b.agentId === bob.id)).toHaveLength(MAX_AGENT_FOLLOW_UPS)
    // What a human message does on its way to the channel sessions.
    setFollowUps(storage, channelSession(bob.id).id, 0)
    await service.sendMessage({ agentId: alice.id, target: `#${channel.name}`, content: `@${bob.name} again`, force: true })
    await vi.waitFor(() => expect(toChannelSession).toHaveLength(MAX_AGENT_FOLLOW_UPS + 1))
  })

  it('a mentioned member that is running is left to its nudge, not woken again', async () => {
    const { channel, alice, bob, channelSession, service } = setup()
    storage.updateBinding(channelSession(bob.id).id, { status: 'active', activeChatId: 998 })
    await service.sendMessage({ agentId: alice.id, target: `#${channel.name}`, content: `@${bob.name} fyi` })
    await new Promise((r) => setTimeout(r, 20))
    expect(toChannelSession).toHaveLength(0)
  })

  it("a thread's report in the main channel wakes the members it mentions", async () => {
    const { channel, alice, bob, human, service, threadService } = setup()
    const root = human('fix it')
    await service.openThread({ agentId: alice.id, message: toShortId(root.id), brief: 'Fixing.' })
    await threadService(root.id).updateThread({
      agentId: alice.id, status: 'done', channelMessage: `Fixed. @${bob.name} can you review?`,
    })
    await vi.waitFor(() => expect(toChannelSession).toHaveLength(1))
    expect(toChannelSession[0]).toMatchObject({ agentId: bob.id, scopeKind: 'app', scopeKey: String(channel.id) })
  })

  it('posting under a message with no thread opens one the channel session owns, without starting anyone', async () => {
    const { channel, alice, human, service } = setup()
    const root = human('logs please')
    const result = await service.sendMessage({ agentId: alice.id, target: `#${channel.name}:${toShortId(root.id)}`, content: 'long logs…' })
    expect(result.status).toBe('sent')
    expect(storage.getThread(root.id)?.ownerAgentId).toBe(alice.id)
    await new Promise((r) => setTimeout(r, 20))
    expect(toThread).toHaveLength(0)

    // Someone replying there is what starts the owner's thread session.
    await routeThreadMessage(storage, channel, human('what does line 3 mean?', root.id))
    expect(toThread.map((b) => b.agentId)).toEqual([alice.id])
  })

  it('read_history reads the channels the agent is in and their threads, and no others', async () => {
    const { project, channel, alice, human, service } = setup()
    const root = human('q')
    human('in the thread', root.id)
    const other = storage.createChannel({ projectId: project.id, name: `private${seq}` })
    storage.createMessage({ channelId: other.id, senderType: 'human', senderName: 'you', content: 'secret' })

    const main = await service.readHistory({ channel: `#${channel.name}`, limit: 50, agentId: alice.id })
    expect(main.messages.map((m) => m.formatted).join('\n')).toContain('q')
    const thread = await service.readHistory({ channel: `#${channel.name}:${toShortId(root.id)}`, limit: 50, agentId: alice.id })
    expect(thread.messages).toHaveLength(2)
    await expect(service.readHistory({ channel: `#${other.name}`, limit: 50, agentId: alice.id })).rejects.toThrow(/not a member/)
    await expect(service.sendMessage({ agentId: alice.id, target: `#${other.name}`, content: 'hi' })).rejects.toThrow(/not a member/)
    expect(storage.listMessages(other.id).messages).toHaveLength(1)
    storage.addMember(other.id, alice.id)
    expect((await service.readHistory({ channel: `#${other.name}`, limit: 50, agentId: alice.id })).messages).toHaveLength(1)
  })

  it('list_server lists only the channels the agent is in, with the other members of each', async () => {
    const { project, channel, alice, bob, service } = setup()
    storage.createChannel({ projectId: project.id, name: `elsewhere${seq}` })
    const { channels } = await service.listServer(alice.id)
    expect(channels.map((c) => c.name)).toEqual([channel.name])
    expect(channels[0].members.map((m) => m.name)).toEqual([bob.name])
  })

  it('check_messages in a thread session reads only its thread', async () => {
    const { channel, alice, human, service, threadService } = setup()
    const root = human('q')
    await service.openThread({ agentId: alice.id, message: toShortId(root.id), brief: 'brief' })
    human('main chatter')
    human('in the thread', root.id)
    const lines = await threadService(root.id).checkMessages(alice.id)
    expect(lines).toHaveLength(2)
    expect(lines.every((l) => l.includes(`target=#${channel.name}:${toShortId(root.id)}`))).toBe(true)
    expect(await threadService(root.id).checkMessages(alice.id)).toEqual([])
  })

  it('lists threads with owner, status and summary', async () => {
    const { alice, human, service, threadService } = setup()
    const root = human('the thing')
    await service.openThread({ agentId: alice.id, message: toShortId(root.id), brief: 'b' })
    await threadService(root.id).updateThread({ agentId: alice.id, status: 'waiting', summary: 'Need a decision on X' })
    const [line] = await service.listThreads({})
    expect(line).toContain('status=waiting')
    expect(line).toContain(`owner=@${alice.name}`)
    expect(line).toContain('summary: Need a decision on X')
  })
})
