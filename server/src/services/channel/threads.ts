/**
 * Channel threads as units of work.
 *
 * A thread hangs off one root message and has an owner: the agent doing the
 * work there. Each agent working in a thread does so in its own *thread
 * session* (a 'thread' binding), separate from its channel session:
 *
 *   - the channel session takes work on with open_thread: it claims the thread,
 *     posts a brief there and the owner's thread session starts on it;
 *   - the thread session reads only that thread, works, and reports back with
 *     update_thread (status / summary, optionally a message in the main channel).
 *
 * Everything that passes between sessions is an ordinary message someone can
 * read — the brief, a follow-up forwarded into the thread, the result posted
 * back — so there is no hidden channel between them.
 *
 * A thread works like a small channel: its members are the agents with a
 * session in it (the owner, and whoever was @mentioned into it), and every
 * member hears every human reply — who answers is settled the way it is in the
 * main channel. The owner is the one reporting the thread's state.
 *
 * Routing a thread reply:
 *   human                      → every member's thread session; @mentioned members not in it yet join
 *                                (an ownerless thread is claimed by the first one mentioned)
 *   human, no members, no owner→ the channel sessions (whoever takes it calls open_thread)
 *   agent from inside the thread → nudge running participants; wake mentioned members (bounded)
 *   agent from elsewhere (its channel session forwarding) → the owner's thread session, and mentions
 *
 * Starting sessions lives in the orchestrator; it registers the two delivery
 * functions here at init, so the agent-facing tools need not import it.
 */

import type { AgentBindingStorageAdapter, ChannelStorageAdapter } from '../../storage/interface.js'
import type { AgentBinding } from '../../types/agent-binding.js'
import type { Agent, Channel, ChannelMessage, ChannelThread, ChannelThreadStatus, ChannelThreadView, WaitingSession } from '../../types/channel.js'
import { emitChannelEvent, publishChannelMessage } from '../channel-bus.js'
import { listPendingApprovals } from '../ai/chat-pending-input.js'
import { getFollowUps, MAX_AGENT_FOLLOW_UPS, nudgeActivePeers, setFollowUps } from './peer-awareness.js'
import { threadTarget } from './session-stream.js'

export type ThreadStorage = ChannelStorageAdapter & AgentBindingStorageAdapter

interface ThreadDelivery {
  /** Deliver to a thread session (inject when running, else wake it). */
  toThreadSession(binding: AgentBinding): Promise<void>
  /** Deliver a message to every member's channel session. */
  toChannelSessions(channelId: number, message: ChannelMessage): Promise<void>
}

let delivery: ThreadDelivery | null = null

export function registerThreadDelivery(d: ThreadDelivery): void {
  delivery = d
}

// ---- Reading ----

export function threadView(storage: ThreadStorage, thread: ChannelThread): ChannelThreadView {
  const sessions = storage.listBindingsForScope('thread', String(thread.rootMessageId))
  return {
    ...thread,
    participantAgentIds: sessions.map((b) => b.agentId),
    activeAgentIds: sessions.filter((b) => b.status === 'active').map((b) => b.agentId),
    waiting: waitingSessions(sessions),
  }
}

/**
 * Which of these sessions are blocked on a person (an approval or a question).
 * Nobody watches an agent's own chat, so the channel shows these where the
 * session lives — in its thread, or above the channel's composer.
 */
export function waitingSessions(sessions: AgentBinding[]): WaitingSession[] {
  const waiting: WaitingSession[] = []
  for (const b of sessions) {
    if (b.activeChatId == null) continue
    const pending = listPendingApprovals(b.activeChatId)
    if (pending.length > 0) waiting.push({ agentId: b.agentId, chatId: b.activeChatId, approvalIds: pending.map((p) => p.approvalId) })
  }
  return waiting
}

/** The channel sessions of a channel that are waiting on a person. */
export function channelSessionsWaiting(storage: ThreadStorage, channelId: number): WaitingSession[] {
  return waitingSessions(storage.listBindingsForScope('app', String(channelId)))
}

/**
 * A chat's pending input changed: if it is a channel or thread session's chat,
 * tell that channel's viewers so the approval shows where the session lives.
 */
export function onSessionInputChanged(storage: ThreadStorage, chatId: number): void {
  const binding = storage.getBindingByActiveChatId(chatId)
  if (!binding) return
  if (binding.scopeKind === 'thread') {
    emitThreadUpdated(storage, Number(binding.scopeKey))
  } else if (binding.scopeKind === 'app') {
    const channelId = Number(binding.scopeKey)
    emitChannelEvent(channelId, { type: 'sessions_waiting', data: channelSessionsWaiting(storage, channelId) })
  }
}

/** Push the thread's current state to the channel's viewers. */
export function emitThreadUpdated(storage: ThreadStorage, rootMessageId: number): void {
  const thread = storage.getThread(rootMessageId)
  if (thread) emitChannelEvent(thread.channelId, { type: 'thread_updated', data: threadView(storage, thread) })
}

/**
 * The root message a thread in `channelId` hangs off, or an error saying why
 * `rootId` can't be one. Threads cannot be nested, so a reply is never a root.
 */
export function resolveThreadRoot(
  storage: Pick<ChannelStorageAdapter, 'getChannelMessage'>,
  channelId: number,
  rootId: number,
): { root: ChannelMessage } | { error: string } {
  if (!Number.isFinite(rootId) || rootId <= 0) return { error: 'Invalid message id.' }
  const root = storage.getChannelMessage(rootId)
  if (!root || root.channelId !== channelId) return { error: 'No such message in this channel.' }
  if (root.threadRootId != null) return { error: 'That message is itself a thread reply; threads cannot be nested.' }
  if (root.senderType === 'system') return { error: 'Threads cannot be started on system notices.' }
  return { root }
}

function memberAgents(storage: ThreadStorage, channelId: number): Agent[] {
  return storage
    .listMembers(channelId)
    .map((m) => storage.getAgent(m.agentId))
    .filter((a): a is Agent => a != null)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Channel members @mentioned in `content`, in the order they appear. */
export function mentionedMembers(storage: ThreadStorage, channelId: number, content: string): Agent[] {
  const found: Array<{ agent: Agent; at: number }> = []
  for (const agent of memberAgents(storage, channelId)) {
    const re = new RegExp(`(^|[^\\w@])@${escapeRegExp(agent.name)}(?![\\w-])`, 'i')
    const m = re.exec(content)
    if (m) found.push({ agent, at: m.index })
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.agent)
}

// ---- Sessions ----

/**
 * The (agent × channel) channel session, created on first encounter. Its
 * workspace is the agent's shared one in the project: any other channel
 * session of the agent there already points at it.
 */
export function ensureChannelSession(
  storage: ThreadStorage,
  channel: Pick<Channel, 'id' | 'name' | 'projectId'>,
  agentId: number,
): AgentBinding {
  const existing = storage.getBindingByScope('app', String(channel.id), agentId)
  if (existing) return existing
  const sharedWorkspaceId = storage
    .listBindings({ scopeKind: 'app', agentId, projectId: channel.projectId })
    .find((b) => b.workspaceId != null)?.workspaceId ?? null
  return storage.upsertBinding({
    agentId,
    scopeKind: 'app',
    scopeKey: String(channel.id),
    scopeDisplayName: `#${channel.name}`,
    channelKind: 'channel',
    projectId: channel.projectId,
    workspaceId: sharedWorkspaceId,
    status: 'offline',
  })
}

/**
 * The agent's session for this thread, created on first need. Its workspace is
 * copied from the agent's channel session (shared, not a worktree of its own)
 * and kept on the binding, so a later move to an isolated worktree only has to
 * change this binding's workspace.
 */
export function ensureThreadBinding(storage: ThreadStorage, thread: ChannelThread, agentId: number): AgentBinding {
  const existing = storage.getBindingByScope('thread', String(thread.rootMessageId), agentId)
  if (existing) return existing
  const channel = storage.getChannel(thread.channelId)
  const channelSession = storage.getBindingByScope('app', String(thread.channelId), agentId)
  const workspaceId = channelSession?.workspaceId
    ?? (channel ? storage.listBindings({ scopeKind: 'app', agentId, projectId: channel.projectId }).find((b) => b.workspaceId != null)?.workspaceId : null)
    ?? null
  return storage.upsertBinding({
    agentId,
    scopeKind: 'thread',
    scopeKey: String(thread.rootMessageId),
    scopeDisplayName: channel ? `${threadTarget(channel.name, thread.rootMessageId)}` : null,
    channelKind: 'channel',
    projectId: channel?.projectId ?? null,
    workspaceId,
    status: 'offline',
  })
}

/** Ensure the thread row for a root a human is replying under; the root's agent author owns it. */
export function ensureThreadForHumanReply(storage: ThreadStorage, root: ChannelMessage): ChannelThread {
  const existing = storage.getThread(root.id)
  if (existing) return existing
  const authorIsMember = root.senderType === 'agent' && root.senderId != null
    && storage.listMembers(root.channelId).some((m) => m.agentId === root.senderId)
  const thread = storage.ensureThread({
    rootMessageId: root.id,
    channelId: root.channelId,
    ownerAgentId: authorIsMember ? root.senderId : null,
    createdByType: 'human',
  })
  emitThreadUpdated(storage, root.id)
  return thread
}

// ---- Agent tools ----

export type OpenThreadResult =
  | { status: 'opened'; target: string; owner: string; messageId: number }
  /**
   * Someone else owns it; `latest` is what the thread says so far (the owner's
   * brief first), so the caller can tell whether it has anything to add.
   */
  | { status: 'taken'; target: string; owner: string; latest: ThreadExcerpt[] }
  /** The owner already has a session working this thread: nothing was posted. */
  | { status: 'exists'; target: string; owner: string }

/** A thread reply as shown to an agent that didn't get the thread. */
export interface ThreadExcerpt {
  sender: string
  content: string
}

const TAKEN_EXCERPT_COUNT = 3
const TAKEN_EXCERPT_CHARS = 1500

/** The thread's first reply (normally the owner's brief) and its latest ones, trimmed. */
function threadExcerpt(storage: ThreadStorage, rootMessageId: number): ThreadExcerpt[] {
  const replies = storage.listThreadReplies(rootMessageId).filter((m) => m.senderType !== 'system')
  const picked = replies.length <= TAKEN_EXCERPT_COUNT
    ? replies
    : [replies[0], ...replies.slice(-(TAKEN_EXCERPT_COUNT - 1))]
  return picked.map((m) => ({
    sender: m.senderName,
    content: m.content.length > TAKEN_EXCERPT_CHARS ? `${m.content.slice(0, TAKEN_EXCERPT_CHARS)}…` : m.content,
  }))
}

/**
 * open_thread: take on the work under `root` — claim the thread for `ownerId`
 * (default: the caller), post the caller's brief there, and start the owner's
 * thread session on it. One thread per message: if another agent already owns
 * it, nothing is posted and the result says who, with what the thread says so
 * far — the caller may still have something to pass on to the owner.
 */
export async function openThread(
  storage: ThreadStorage,
  input: {
    channel: Channel
    root: ChannelMessage
    callerAgentId: number
    callerBindingId: number | null
    ownerAgentId: number
    brief: string
  },
): Promise<OpenThreadResult> {
  const { channel, root } = input
  const target = threadTarget(channel.name, root.id)
  const ownerName = storage.getAgent(input.ownerAgentId)?.name ?? `Agent ${input.ownerAgentId}`

  let thread = storage.ensureThread({
    rootMessageId: root.id,
    channelId: channel.id,
    ownerAgentId: null,
    createdByType: 'agent',
    createdById: input.callerAgentId,
  })
  if (thread.ownerAgentId == null) thread = storage.claimThread(root.id, input.ownerAgentId) ?? thread
  if (thread.ownerAgentId !== input.ownerAgentId) {
    const current = thread.ownerAgentId != null ? storage.getAgent(thread.ownerAgentId)?.name : null
    return { status: 'taken', target, owner: current ?? 'someone else', latest: threadExcerpt(storage, root.id) }
  }
  // Already being worked by its owner's session (a second open_thread arriving
  // late, or a repeat): posting the brief again would reopen a finished thread
  // and wake its session on a duplicate. Follow-ups go in with send_message.
  if (storage.getBindingByScope('thread', String(root.id), input.ownerAgentId) != null) {
    return { status: 'exists', target, owner: ownerName }
  }
  if (thread.status !== 'open') storage.updateThread(root.id, { status: 'open' })

  const caller = storage.getAgent(input.callerAgentId)
  // The brief is the caller's channel session's message — never "the owner's
  // own", or a thread the caller keeps would hide it from its own thread session.
  const callerBindingId = input.callerBindingId ?? ensureChannelSession(storage, channel, input.callerAgentId).id
  const brief = storage.createMessage({
    channelId: channel.id,
    threadRootId: root.id,
    senderType: 'agent',
    senderId: input.callerAgentId,
    senderName: caller?.name ?? String(input.callerAgentId),
    content: input.brief,
    senderBindingId: callerBindingId,
  })
  publishChannelMessage(storage, brief)
  nudgeActivePeers(storage, channel, brief)

  const session = ensureThreadBinding(storage, thread, input.ownerAgentId)
  // Handed work by a channel session: a fresh start, not an agent follow-up.
  setFollowUps(storage, session.id, 0)
  emitThreadUpdated(storage, root.id)
  // Starting a session can take a while; the tool call doesn't wait for it.
  void deliverToSession(session)
  return { status: 'opened', target, owner: ownerName, messageId: brief.id }
}

/**
 * update_thread: the owner reports the thread's state. `channelMessage` also
 * posts a message in the main channel — a report, so it wakes nobody: the
 * channel sessions read it with their next messages.
 */
export function reportThread(
  storage: ThreadStorage,
  input: {
    thread: ChannelThread
    channel: Channel
    agentId: number
    bindingId: number | null
    status?: ChannelThreadStatus
    summary?: string
    channelMessage?: string
  },
): { channelMessageId: number | null } {
  const { thread, channel } = input
  storage.updateThread(thread.rootMessageId, {
    ...(input.status ? { status: input.status } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
  })
  let channelMessageId: number | null = null
  if (input.channelMessage?.trim()) {
    const agent = storage.getAgent(input.agentId)
    const message = storage.createMessage({
      channelId: channel.id,
      senderType: 'agent',
      senderId: input.agentId,
      senderName: agent?.name ?? String(input.agentId),
      content: input.channelMessage,
      senderBindingId: input.bindingId,
    })
    publishChannelMessage(storage, message)
    channelMessageId = message.id
  }
  emitThreadUpdated(storage, thread.rootMessageId)
  return { channelMessageId }
}

/**
 * Take an agent out of a thread: its thread session stops and goes, so it no
 * longer hears the thread (an @mention brings it back, with the thread so far).
 * If it owned the thread, the thread is nobody's until someone takes it.
 */
export async function removeThreadMember(
  storage: ThreadStorage,
  rootMessageId: number,
  agentId: number,
  stop: (binding: AgentBinding) => Promise<void>,
): Promise<boolean> {
  const thread = storage.getThread(rootMessageId)
  if (!thread) return false
  const binding = storage.getBindingByScope('thread', String(rootMessageId), agentId)
  const wasOwner = thread.ownerAgentId === agentId
  if (!binding && !wasOwner) return false
  if (binding) {
    await stop(binding)
    storage.deleteBinding(binding.id)
  }
  if (wasOwner) storage.updateThread(rootMessageId, { ownerAgentId: null })
  emitThreadUpdated(storage, rootMessageId)
  return true
}

// ---- Routing ----

/** Agents with a session in the thread — its members. */
function threadMemberIds(storage: ThreadStorage, rootMessageId: number): number[] {
  return storage.listBindingsForScope('thread', String(rootMessageId)).map((b) => b.agentId)
}

async function deliverToSession(binding: AgentBinding): Promise<void> {
  if (!delivery) return
  try {
    await delivery.toThreadSession(binding)
  } catch (err) {
    console.error(`[Threads] delivery to binding=${binding.id} failed:`, err)
  }
}

/**
 * Route a reply in a thread to the sessions it is for (see the table at the
 * top). Called after the message is stored and emitted; `nudgeActivePeers` for
 * agent messages is the sender's business (workspace chat already does it).
 */
export async function routeThreadMessage(storage: ThreadStorage, channel: Channel, message: ChannelMessage): Promise<void> {
  const rootId = message.threadRootId
  if (rootId == null) return
  const thread = storage.getThread(rootId)
  if (!thread) {
    console.warn(`[Threads] route: no thread row for root=${rootId}`)
    return
  }

  const mentioned = mentionedMembers(storage, channel.id, message.content)
    .filter((a) => !(message.senderType === 'agent' && a.id === message.senderId))

  if (message.senderType === 'human') {
    // A human spoke: the thread is open again, and agent-only follow-ups count from zero.
    if (thread.status !== 'open') storage.updateThread(rootId, { status: 'open' })
    for (const b of storage.listBindingsForScope('thread', String(rootId))) setFollowUps(storage, b.id, 0)

    let ownerId = thread.ownerAgentId
    if (ownerId == null && mentioned.length > 0) ownerId = storage.claimThread(rootId, mentioned[0].id)?.ownerAgentId ?? null
    // Like the main channel, everyone in the thread hears it: the owner, the
    // members already in, and whoever is @mentioned into it now. Mentioned
    // first, so the one being asked starts first.
    const recipients = [...new Set([
      ...mentioned.map((a) => a.id),
      ...(ownerId != null ? [ownerId] : []),
      ...threadMemberIds(storage, rootId),
    ])]
    emitThreadUpdated(storage, rootId)

    if (recipients.length === 0) {
      // Nobody owns it: the channel sessions see it and whoever takes it claims it.
      await delivery?.toChannelSessions(channel.id, message)
      return
    }
    const current = storage.getThread(rootId) ?? thread
    for (const agentId of recipients) await deliverToSession(ensureThreadBinding(storage, current, agentId))
    return
  }

  if (message.senderType !== 'agent') return

  const sender = message.senderBindingId != null ? storage.getBinding(message.senderBindingId) : null
  let delivered = false

  // Passed on by a channel session (something came up in the main channel): it
  // is for the owner, and it is a handoff — like open_thread, not an agent
  // follow-up, since what prompted it was usually a human in the main channel.
  // An agent's channel session posting into its own thread that has no session
  // yet (details under its answer, a thread it just opened by posting) starts
  // nothing: the thread session starts when someone replies there.
  const selfWithoutSession = sender?.agentId === thread.ownerAgentId
    && storage.getBindingByScope('thread', String(rootId), sender?.agentId ?? -1) == null
  if (sender?.scopeKind === 'app' && thread.ownerAgentId != null && !selfWithoutSession) {
    const session = ensureThreadBinding(storage, thread, thread.ownerAgentId)
    if (session.id !== message.senderBindingId) {
      setFollowUps(storage, session.id, 0)
      await deliverToSession(session)
      delivered = true
    }
  }

  for (const agent of mentioned) {
    if (sender?.scopeKind === 'app' && agent.id === thread.ownerAgentId) continue
    const session = ensureThreadBinding(storage, thread, agent.id)
    if (session.id === message.senderBindingId) continue
    // Agent-to-agent wakes are bounded the same way as at turn end, so two
    // agents mentioning each other can't keep each other running.
    const n = getFollowUps(storage, session.id)
    if (n >= MAX_AGENT_FOLLOW_UPS) {
      console.log(`[Threads] route: binding=${session.id} at follow-up limit, leaving message unread`)
      continue
    }
    setFollowUps(storage, session.id, n + 1)
    await deliverToSession(session)
    delivered = true
  }
  if (delivered) emitThreadUpdated(storage, rootId)
}
