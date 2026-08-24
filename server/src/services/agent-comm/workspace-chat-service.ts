import type {
  AgentMessageSurface,
  BridgeAgent,
  BridgeChannel,
  HistoryMessage,
  ReadHistoryResult,
  UploadResult,
  ViewFileResult,
} from './message-surface.js'
import type {
  AgentBindingStorageAdapter,
  ChannelStorageAdapter,
} from '../../storage/interface.js'
import { emitChannelEvent } from '../channel-bus.js'
import { injectIntoChat } from '../ai.js'
import type { ChannelMessage } from '../../types/channel.js'

// ---- Helpers ----

/** Convert a message id to an 8-char hex short id (used in target format). */
function toShortId(id: number): string {
  return id.toString(16).padStart(8, '0')
}

/** Parse an 8-char hex short id back to a numeric id. */
function fromShortId(s: string): number {
  return parseInt(s, 16)
}

/** Convert ISO to local time string for display (matches slock). */
function toLocalTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * Format a message in RFC-5424-inspired envelope style:
 *   [target=#general msg=a1b2c3d4 time=... sender=Alice type=user] content
 *
 * All sender metadata lives inside the bracketed header. `@` in the content is
 * reserved for real mentions.
 */
function formatMessage(msg: ChannelMessage, channelName: string): string {
  const shortId = toShortId(msg.id)
  const parentTarget = msg.threadRootId
    ? `#${channelName}:${toShortId(msg.threadRootId)}`
    : `#${channelName}`
  const time = toLocalTime(new Date(msg.createdAt).toISOString())
  const type = msg.senderType === 'agent' ? 'agent' : 'user'
  return `[target=${parentTarget} msg=${shortId} time=${time} sender=${msg.senderName} type=${type}] ${msg.content}`
}

/**
 * Parse target string into parts. Supports:
 *   '#channelName'         -> { channelName }
 *   '#channelName:shortId' -> { channelName, threadRootId }
 */
function parseTarget(target: string): { channelName: string; threadRootId?: number } {
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
  ) {}

  private getChannelByName(name: string) {
    return this.storage.listChannels(this.projectId).find((c) => c.name === name) ?? null
  }

  async sendMessage({ target, content, agentId }: {
    target: string
    content: string
    agentId: number
    attachmentIds?: string[]
  }): Promise<{ messageId: string }> {
    const parsed = parseTarget(target)

    const channel = this.getChannelByName(parsed.channelName)
    if (!channel) throw new Error(`Channel not found: ${parsed.channelName}`)

    const agent = this.storage.getAgent(agentId)
    const senderName = agent?.name ?? String(agentId)

    const message = this.storage.createMessage({
      channelId: channel.id,
      threadRootId: parsed.threadRootId ?? null,
      senderType: 'agent',
      senderId: agentId,
      senderName,
      content,
    })

    // Advance own read cursor past this message so the agent's own outbound
    // never appears in its own getUnreadChannelMessages result.
    this.storage.upsertCursor(agentId, 'app', String(channel.id), message.id)

    emitChannelEvent(channel.id, { type: 'channel_message', data: message })
    return { messageId: toShortId(message.id) }
  }

  async checkMessages(agentId: number): Promise<string[]> {
    const allChannels = this.storage.listChannels(this.projectId)
    const lines: string[] = []

    for (const channel of allChannels) {
      const members = this.storage.listMembers(channel.id)
      if (!members.some((m) => m.agentId === agentId)) continue

      const unread = this.storage.getUnreadChannelMessages(agentId, channel.id)
      if (unread.length === 0) continue

      const maxSeq = unread[unread.length - 1].id
      this.storage.upsertCursor(agentId, 'app', String(channel.id), maxSeq)

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

    let messages: ChannelMessage[]
    if (parsed.threadRootId) {
      const root = this.storage
        .listMessages(channelObj.id, { limit: 1e6 })
        .messages
        .find((m) => m.id === parsed.threadRootId)
      const replies = this.storage.listThreadReplies(parsed.threadRootId)
      messages = root ? [root, ...replies] : replies
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
      const cursor = this.storage.getCursor(agentId, 'app', String(channelObj.id))
      if (cursor) lastReadSeq = cursor.lastReadId
    }

    return { messages: formatted, hasMore, lastReadSeq }
  }

  async listServer(): Promise<{ channels: BridgeChannel[]; agents: BridgeAgent[]; humans: { name: string }[] }> {
    const allChannels = this.storage.listChannels(this.projectId)

    const channels = allChannels.map((c): BridgeChannel => ({
      name: c.name,
      description: c.description,
      joined: true,
    }))

    const projectBindings = this.storage.listBindings({
      scopeKind: 'app',
      projectId: this.projectId,
    })
    const statusByAgent = new Map<number, 'active' | 'idle' | 'offline'>()
    for (const b of projectBindings) {
      const cur = statusByAgent.get(b.agentId)
      if (b.status === 'active') statusByAgent.set(b.agentId, 'active')
      else if (b.status === 'idle' && cur !== 'active') statusByAgent.set(b.agentId, 'idle')
      else if (cur == null) statusByAgent.set(b.agentId, 'offline')
    }

    const agents = this.storage.listAgents().map((a): BridgeAgent => ({
      name: a.name,
      status: statusByAgent.get(a.id) ?? 'offline',
    }))

    return { channels, agents, humans: [{ name: 'user' }] }
  }

  async uploadFile(_filePath: string, _channel: string): Promise<UploadResult> {
    throw new Error('File upload not supported in this version')
  }

  async viewFile(_attachmentId: string): Promise<ViewFileResult> {
    throw new Error('File view not supported in this version')
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
    await injectIntoChat(b.activeChatId, notification)
  }
}
