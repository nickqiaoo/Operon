import type {
  AgentMessageSurface,
  BridgeAgent,
  BridgeChannel,
  HistoryMessage,
  ReadHistoryResult,
  SendMessageResult,
} from './message-surface.js'
import type {
  AgentBindingStorageAdapter,
  ChannelStorageAdapter,
} from '../../storage/interface.js'
import { publishChannelMessage } from '../channel-bus.js'
import { injectIntoChat } from '../ai.js'
import { formatChannelMessage as formatMessage, fromShortId, toShortId } from './channel-message-format.js'
import { nudgeActivePeers, selectHeldMessages } from '../channel/peer-awareness.js'
import { markReadIn, threadTarget, unreadIn, type SessionStream } from '../channel/session-stream.js'
import { storeLocalImages } from '../channel/channel-attachments.js'
import {
  emitThreadUpdated,
  openThread,
  reportThread,
  resolveThreadRoot,
  routeChannelMentions,
  routeThreadMessage,
  type OpenThreadResult,
} from '../channel/threads.js'
import type { AgentBinding } from '../../types/agent-binding.js'
import type { Agent, Channel, ChannelMessage, ChannelThreadStatus } from '../../types/channel.js'

// ---- Helpers ----

/**
 * Parse target string into parts. Supports:
 *   '#channelName'         -> { channelName }
 *   '#channelName:shortId' -> { channelName, threadRootId }
 */
function parseTarget(target: string): { channelName: string; threadRootId?: number } {
  target = target.trim()
  if (target.startsWith('dm:')) {
    throw new Error('DM not supported in workspace_chat. Use #channel format.')
  }
  if (!target.startsWith('#')) {
    throw new Error(`Invalid target format: ${target}. Expected '#channel' or '#channel:shortId'.`)
  }
  const body = target.slice(1)
  const colon = body.indexOf(':')
  if (colon < 0) return { channelName: body }
  return {
    channelName: body.slice(0, colon),
    threadRootId: fromShortId(body.slice(colon + 1)),
  }
}

export class WorkspaceChatService implements AgentMessageSurface {
  constructor(
    private readonly storage: ChannelStorageAdapter & AgentBindingStorageAdapter,
    private readonly projectId: number,
    /**
     * The channel the calling session belongs to (one session per channel).
     * Its read cursor is that session's alone: check_messages and the send
     * hold only touch this channel. null = legacy caller without one.
     */
    private readonly sessionChannelId: number | null = null,
    /**
     * Set for a thread session: the root message of its thread (in
     * sessionChannelId). It then reads only that thread, and gets the thread
     * tools instead of the channel ones.
     */
    private readonly sessionThreadRootId: number | null = null,
  ) {}

  /** True when the caller is a thread session. */
  get isThreadSession(): boolean {
    return this.sessionThreadRootId != null
  }

  private getChannelByName(name: string) {
    return this.storage.listChannels(this.projectId).find((c) => c.name === name) ?? null
  }

  /**
   * An agent posts in and reads the channels it is a member of (and their
   * threads), not every channel in the project.
   */
  private assertMember(channel: Channel, agentId: number): void {
    if (this.storage.listMembers(channel.id).some((m) => m.agentId === agentId)) return
    throw new Error(`You are not a member of #${channel.name}; you can use only the channels you belong to and their threads (list_server lists them).`)
  }

  private sessionChannel(): Channel | null {
    if (this.sessionChannelId == null) return null
    const channel = this.storage.getChannel(this.sessionChannelId)
    return channel && channel.projectId === this.projectId ? channel : null
  }

  /** The calling session's binding (its channel or thread session), when it has one. */
  private sessionBinding(agentId: number): AgentBinding | null {
    if (this.sessionThreadRootId != null) {
      return this.storage.getBindingByScope('thread', String(this.sessionThreadRootId), agentId)
    }
    if (this.sessionChannelId != null) {
      return this.storage.getBindingByScope('app', String(this.sessionChannelId), agentId)
    }
    return null
  }

  /** Whether posting to `channelId` / `rootId` (null = main channel) is posting where this session reads. */
  private isOwnStream(channelId: number, rootId: number | null): boolean {
    if (this.sessionThreadRootId != null) return rootId === this.sessionThreadRootId
    return rootId == null && (this.sessionChannelId == null || this.sessionChannelId === channelId)
  }

  async sendMessage({ target, content, agentId, force, images }: {
    target: string
    content: string
    agentId: number
    images?: string[]
    force?: boolean
  }): Promise<SendMessageResult> {
    const parsed = parseTarget(target)
    if (!content.trim() && !(images && images.length > 0)) throw new Error('Nothing to send: content is empty and no images were given.')

    const channel = this.getChannelByName(parsed.channelName)
    if (!channel) throw new Error(`Channel not found: ${parsed.channelName}`)
    this.assertMember(channel, agentId)

    let root: ChannelMessage | null = null
    if (parsed.threadRootId != null) {
      const resolved = resolveThreadRoot(this.storage, channel.id, parsed.threadRootId)
      if ('error' in resolved) throw new Error(`${resolved.error} (target ${target})`)
      root = resolved.root
    }

    // Soft gate: while this agent was writing, others may already have said it.
    // Only a running session posting where it reads (its channel, or its
    // thread) is gated. Posting elsewhere isn't part of that conversation, and
    // holding it would mark the other stream's messages read for a session that
    // isn't this one. Task sessions don't have this tool: they start without a
    // channelId, so chat-flow treats them as a direct chat and mcp-config
    // leaves it out.
    const session = this.sessionBinding(agentId)
    const stream: SessionStream = root
      ? { kind: 'thread', channelId: channel.id, rootMessageId: root.id }
      : { kind: 'channel', channelId: channel.id }
    const gateBinding = session ?? (this.sessionChannelId == null && !root
      ? this.storage.getBindingByScope('app', String(channel.id), agentId)
      : null)
    if (!force && this.isOwnStream(channel.id, root?.id ?? null) && gateBinding?.status === 'active') {
      const held = selectHeldMessages(unreadIn(this.storage, agentId, stream))
      if (held.length > 0) {
        // Showing them is reading them, exactly like check_messages.
        markReadIn(this.storage, agentId, stream, held[held.length - 1].id)
        console.log(
          `[workspace-chat] send held agent=${agentId} target=${target} unread=[${held.map((m) => m.id).join(',')}]`,
        )
        return { status: 'held', pending: held.map((m) => formatMessage(m, channel.name)) }
      }
    }

    const attachments = images?.length ? storeLocalImages(images) : []

    // Posting under a message with no thread yet opens one the poster owns; a
    // channel session posting into a thread nobody owns takes it. (A thread
    // session posting into some other thread is just a message there.)
    let threadChanged = false
    if (root) {
      const fromThreadSession = session?.scopeKind === 'thread'
      const thread = this.storage.getThread(root.id)
      if (!thread) {
        this.storage.ensureThread({
          rootMessageId: root.id,
          channelId: channel.id,
          ownerAgentId: fromThreadSession ? null : agentId,
          createdByType: 'agent',
          createdById: agentId,
        })
        threadChanged = true
      } else if (thread.ownerAgentId == null && !fromThreadSession) {
        this.storage.claimThread(root.id, agentId)
        threadChanged = true
      }
    }

    const agent = this.storage.getAgent(agentId)
    const senderName = agent?.name ?? String(agentId)

    const message = this.storage.createMessage({
      channelId: channel.id,
      threadRootId: root?.id ?? null,
      senderType: 'agent',
      senderId: agentId,
      senderName,
      content,
      senderBindingId: gateBinding?.id ?? null,
      attachments,
    })

    // Sending doesn't touch the read cursor: unread already leaves out the
    // session's own messages, and jumping the cursor here would mark anything
    // that arrived meanwhile as read without the agent ever seeing it.
    publishChannelMessage(this.storage, message)

    if (root) {
      if (threadChanged) emitThreadUpdated(this.storage, root.id)
      // Running sessions in the thread get a nudge; the owner gets what a
      // channel session passes on, mentioned members are brought in.
      nudgeActivePeers(this.storage, channel, message)
      void routeThreadMessage(this.storage, channel, message).catch((err) => {
        console.error('[workspace-chat] thread routing failed:', err)
      })
    } else {
      // Running peers get a nudge to check_messages before they reply. A thread
      // session posting in the main channel is reporting back, which nudges
      // nobody: the channel sessions read it with their next messages.
      if (session?.scopeKind !== 'thread') nudgeActivePeers(this.storage, channel, message)
      // Either way, the members it @mentions are woken (bounded).
      void routeChannelMentions(this.storage, channel, message).catch((err) => {
        console.error('[workspace-chat] channel mention routing failed:', err)
      })
    }
    return { status: 'sent', messageId: toShortId(message.id) }
  }

  async checkMessages(agentId: number): Promise<string[]> {
    if (this.sessionThreadRootId != null) {
      const channel = this.sessionChannel()
      if (!channel) return []
      const stream: SessionStream = { kind: 'thread', channelId: channel.id, rootMessageId: this.sessionThreadRootId }
      const unread = unreadIn(this.storage, agentId, stream)
      if (unread.length === 0) return []
      markReadIn(this.storage, agentId, stream, unread[unread.length - 1].id)
      return unread.map((m) => formatMessage(m, channel.name))
    }

    const allChannels = this.storage.listChannels(this.projectId)
    const channels = this.sessionChannelId == null
      ? allChannels
      : allChannels.filter((c) => c.id === this.sessionChannelId)
    const lines: string[] = []

    for (const channel of channels) {
      const members = this.storage.listMembers(channel.id)
      if (!members.some((m) => m.agentId === agentId)) continue

      const unread = this.storage.getUnreadChannelMessages(agentId, channel.id)
      if (unread.length === 0) continue

      this.storage.upsertCursor(agentId, 'app', String(channel.id), unread[unread.length - 1].id)

      for (const msg of unread) {
        lines.push(formatMessage(msg, channel.name))
      }
    }

    return lines
  }

  async readHistory({ channel, limit, before, after, agentId }: {
    channel: string
    limit: number
    before?: number
    after?: number
    agentId?: number
  }): Promise<ReadHistoryResult> {
    const parsed = parseTarget(channel)
    const channelObj = this.getChannelByName(parsed.channelName)
    if (!channelObj) return { messages: [], hasMore: false, lastReadSeq: 0 }
    if (agentId != null) this.assertMember(channelObj, agentId)

    let messages: ChannelMessage[]
    if (parsed.threadRootId) {
      const resolved = resolveThreadRoot(this.storage, channelObj.id, parsed.threadRootId)
      if ('error' in resolved) throw new Error(`${resolved.error} (${channel})`)
      messages = [resolved.root, ...this.storage.listThreadReplies(resolved.root.id)]
    } else {
      messages = this.storage.listMessages(channelObj.id, { limit: 1e6 }).messages
    }

    if (after !== undefined) messages = messages.filter((m) => m.id > after)
    if (before !== undefined) messages = messages.filter((m) => m.id < before)

    const hasMore = messages.length > limit
    messages = messages.slice(-limit)

    const formatted: HistoryMessage[] = messages.map((m) => ({
      seq: m.id,
      formatted: formatMessage(m, channelObj.name),
    }))

    let lastReadSeq = 0
    if (agentId) {
      const cursor = parsed.threadRootId
        ? this.storage.getCursor(agentId, 'thread', String(parsed.threadRootId))
        : this.storage.getCursor(agentId, 'app', String(channelObj.id))
      if (cursor) lastReadSeq = cursor.lastReadId
    }

    return { messages: formatted, hasMore, lastReadSeq }
  }

  // ---- Threads ----

  /**
   * open_thread (channel sessions): take on the work under a message in a
   * thread — the caller's own thread session, or the named member's.
   */
  async openThread({ agentId, message, brief, agent, channel }: {
    agentId: number
    message: string
    brief: string
    agent?: string
    channel?: string
  }): Promise<OpenThreadResult> {
    if (this.isThreadSession) {
      throw new Error('open_thread belongs to the channel session. You are in a thread session, and threads cannot be nested.')
    }
    const channelObj = channel
      ? this.getChannelByName(channel.replace(/^#/, '').split(':')[0])
      : this.sessionChannel()
    if (!channelObj) throw new Error(channel ? `Channel not found: ${channel}` : 'Pass channel: this session has no channel of its own.')

    const members = this.storage.listMembers(channelObj.id)
    if (!members.some((m) => m.agentId === agentId)) throw new Error(`You are not a member of #${channelObj.name}.`)

    // Accept the bare short id, or a thread-style target ("#general:0000002a").
    const shortId = message.trim().replace(/^#[^:]*:/, '')
    if (!/^[0-9a-f]{1,8}$/i.test(shortId)) throw new Error(`Invalid message id: ${message}. Use the msg= value from the message header.`)
    const resolved = resolveThreadRoot(this.storage, channelObj.id, fromShortId(shortId))
    if ('error' in resolved) throw new Error(resolved.error)

    let ownerId = agentId
    if (agent && agent.trim()) {
      const wanted = agent.trim().replace(/^@/, '').toLowerCase()
      const owner = members
        .map((m) => this.storage.getAgent(m.agentId))
        .find((a) => a != null && a.name.toLowerCase() === wanted)
      if (!owner) throw new Error(`No member named ${agent} in #${channelObj.name}.`)
      ownerId = owner.id
    }
    if (!brief.trim()) throw new Error('brief is required: say what the thread is for, so its session knows what to do.')

    return openThread(this.storage, {
      channel: channelObj,
      root: resolved.root,
      callerAgentId: agentId,
      callerBindingId: this.storage.getBindingByScope('app', String(channelObj.id), agentId)?.id ?? null,
      ownerAgentId: ownerId,
      brief,
    })
  }

  /** update_thread (thread sessions): the owner reports its thread's status and summary. */
  async updateThread({ agentId, status, summary, channelMessage }: {
    agentId: number
    status?: string
    summary?: string
    channelMessage?: string
  }): Promise<{ target: string; status: ChannelThreadStatus; channelMessageId: string | null }> {
    if (this.sessionThreadRootId == null) {
      throw new Error('update_thread is for thread sessions. From the channel session, use list_threads to see threads.')
    }
    const thread = this.storage.getThread(this.sessionThreadRootId)
    const channel = this.sessionChannel()
    if (!thread || !channel) throw new Error('This thread no longer exists.')
    if (thread.ownerAgentId !== agentId) {
      const owner = thread.ownerAgentId != null ? this.storage.getAgent(thread.ownerAgentId)?.name : null
      throw new Error(owner ? `Only the thread's owner (@${owner}) can update it.` : 'Nobody owns this thread, so it has no status to report.')
    }
    if (status !== undefined && status !== 'open' && status !== 'waiting' && status !== 'done') {
      throw new Error(`Invalid status: ${status}. Use "waiting", "done" or "open".`)
    }
    if (status === undefined && summary === undefined && !channelMessage?.trim()) {
      throw new Error('Nothing to update: pass status, summary and/or channel_message.')
    }
    const result = reportThread(this.storage, {
      thread,
      channel,
      agentId,
      bindingId: this.sessionBinding(agentId)?.id ?? null,
      ...(status ? { status } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(channelMessage ? { channelMessage } : {}),
    })
    return {
      target: threadTarget(channel.name, thread.rootMessageId),
      status: this.storage.getThread(thread.rootMessageId)?.status ?? thread.status,
      channelMessageId: result.channelMessageId != null ? toShortId(result.channelMessageId) : null,
    }
  }

  /** list_threads (channel sessions): this channel's threads, most recently active first. */
  async listThreads({ channel, limit = 20 }: { channel?: string; limit?: number }): Promise<string[]> {
    const channelObj = channel
      ? this.getChannelByName(channel.replace(/^#/, '').split(':')[0])
      : this.sessionChannel()
    if (!channelObj) throw new Error(channel ? `Channel not found: ${channel}` : 'Pass channel: this session has no channel of its own.')
    return this.storage.listThreads(channelObj.id, { limit }).map((t) => {
      const root = this.storage.getChannelMessage(t.rootMessageId)
      const owner = t.ownerAgentId != null ? `@${this.storage.getAgent(t.ownerAgentId)?.name ?? t.ownerAgentId}` : 'nobody'
      const running = this.storage
        .listBindingsForScope('thread', String(t.rootMessageId))
        .filter((b) => b.status === 'active')
        .map((b) => `@${this.storage.getAgent(b.agentId)?.name ?? b.agentId}`)
      const excerpt = (root?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
      const parts = [
        `${threadTarget(channelObj.name, t.rootMessageId)}`,
        `status=${t.status}`,
        `owner=${owner}`,
        `replies=${root?.replyCount ?? 0}`,
        running.length > 0 ? `running=${running.join(',')}` : null,
      ].filter(Boolean)
      return `- [${parts.join(' ')}] ${excerpt}${t.summary ? ` — summary: ${t.summary}` : ''}`
    })
  }

  async listServer(agentId: number): Promise<{ channels: BridgeChannel[]; humans: { name: string }[] }> {
    // Running if any of its sessions in the project (channel or thread) is.
    const statusByAgent = new Map<number, 'active' | 'idle' | 'offline'>()
    for (const scopeKind of ['app', 'thread'] as const) {
      for (const b of this.storage.listBindings({ scopeKind, projectId: this.projectId })) {
        const cur = statusByAgent.get(b.agentId)
        if (b.status === 'active') statusByAgent.set(b.agentId, 'active')
        else if (b.status === 'idle' && cur !== 'active') statusByAgent.set(b.agentId, 'idle')
        else if (cur == null) statusByAgent.set(b.agentId, 'offline')
      }
    }

    const channels: BridgeChannel[] = []
    for (const c of this.storage.listChannels(this.projectId)) {
      const memberIds = this.storage.listMembers(c.id).map((m) => m.agentId)
      if (!memberIds.includes(agentId)) continue
      const members = memberIds
        .filter((id) => id !== agentId)
        .map((id) => this.storage.getAgent(id))
        .filter((a): a is Agent => a != null && !a.hidden)
        .map((a): BridgeAgent => ({ name: a.name, status: statusByAgent.get(a.id) ?? 'offline' }))
      channels.push({ name: c.name, description: c.description, members })
    }

    return { channels, humans: [{ name: 'user' }] }
  }

}

/**
 * Notify an agent by injecting a message into its active app binding chat(s) in
 * a project. No-op if the agent has no active app binding in that project.
 */
export async function notifyAgent(
  storage: AgentBindingStorageAdapter,
  agentId: number,
  projectId: number,
  notification: string,
): Promise<void> {
  const bindings = storage.listBindings({
    scopeKind: 'app',
    agentId,
    projectId,
    status: 'active',
  })
  for (const b of bindings) {
    if (b.activeChatId == null) continue
    const receipt = await injectIntoChat(b.activeChatId, notification, undefined, { mode: 'auto' })
    if (!receipt.success) console.warn('[workspace-chat] notification delivery', receipt.delivery, receipt.error)
  }
}
