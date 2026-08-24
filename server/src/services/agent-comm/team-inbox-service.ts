/**
 * TeamInboxService — agent-to-agent point-to-point messaging.
 *
 * This is the data layer for the inbox MCP tools. Agents on a task team use
 * `send_to_agent` / `inbox_check` / `list_team_peers` to coordinate without
 * polluting any channel or task thread.
 *
 * Delivery: when an inbox message is written, the orchestrator looks up the
 * recipient's currently-active binding (if any) and injects a notification
 * into its running chat. If the recipient has no active binding, the message
 * is held until they next start a session — startup routine pulls inbox via
 * `inbox_check`.
 *
 * Scope note: this was built for the (now retired) Linear Agent integration and
 * later ported to task bindings, which are the only live scope today.
 */

import type {
  AgentBindingStorageAdapter,
  ChannelStorageAdapter,
} from '../../storage/interface.js'
import type { AgentBinding } from '../../types/agent-binding.js'
import { injectIntoChat } from '../ai.js'
import { wakeTaskBinding } from '../channel/agent-orchestrator.js'

/**
 * Parse a peer handle in the form "name@<ref>" (e.g. "coder@task-7"). The ref is
 * the recipient binding's scopeDisplayName.
 * Tolerates a single leading "@" mention prefix. Returns nulls if the input
 * has no separator — caller decides whether to error.
 */
function parseHandle(raw: string): { agentName: string; issueIdentifier: string | null } {
  const trimmed = raw.trim().replace(/^@/, '')
  const at = trimmed.indexOf('@')
  if (at < 0) return { agentName: trimmed, issueIdentifier: null }
  const agentName = trimmed.slice(0, at)
  const issueIdentifier = trimmed.slice(at + 1)
  return {
    agentName,
    issueIdentifier: issueIdentifier.length > 0 ? issueIdentifier : null,
  }
}

export interface InboxSendResult {
  messageId: number
  /**
   * - `injected`: recipient was actively streaming; message steered into the
   *   live chat via injectIntoChat.
   * - `woken`: recipient was idle; its binding was woken with a fresh turn so
   *   the agent reads the message via `inbox_check` after waking.
   * - `queued`: neither path succeeded — inbox row is persisted, the agent
   *   will pick it up the next time it's awakened by something else.
   */
  delivered: 'injected' | 'woken' | 'queued'
}

export interface InboxMessageView {
  id: number
  senderName: string
  senderAgentId: number | null
  content: string
  ref: { kind: string; id: string } | null
  createdAt: number
  formatted: string
}

export interface InboxHistoryResult {
  messages: InboxMessageView[]
  hasMore: boolean
}

export interface TeamPeerView {
  /** Stable routable identifier in the form `name@<ref>` (or just `name`
   *  when the binding has no scopeDisplayName). LLM should copy this verbatim into
   *  send_to_agent.to. */
  handle: string
  name: string
  description: string
  status: AgentBinding['status']
  scopeDisplayName: string | null
  agentSessionId: string | null
}

export interface AgentDirectoryEntry {
  name: string
  description: string
}

type Storage = AgentBindingStorageAdapter
  & Pick<ChannelStorageAdapter, 'getAgent' | 'getAgentByName' | 'listAgents'>

export class TeamInboxService {
  /**
   * Cached scopeDisplayName (e.g. "task-7") of the sender's current binding.
   * Used as routing key for both send (filtering recipient binding)
   * and check (filtering inbox + per-session cursor). Reverse-looked-up once
   * at construction; null only if the sender's session is unknown to storage.
   */
  private readonly senderBinding: AgentBinding | null
  private readonly senderScopeDisplayName: string | null

  /**
   * @param senderAgentSessionId The sender binding's session key (a task
   *   binding's agent_session_id). Used to resolve the sender's binding (scope
   *   kind + team label + own identifier) for peer scoping and inbox filtering.
   *   Peer discovery is scoped to bindings of the same scope kind.
   */
  constructor(
    private storage: Storage,
    private senderAgentId: number,
    senderAgentSessionId: string,
  ) {
    this.senderBinding = this.storage.getBindingByAgentSessionId(senderAgentSessionId)
    this.senderScopeDisplayName = this.senderBinding?.scopeDisplayName ?? null
  }

  /**
   * Send a message from this agent's session to another agent's specific
   * session, identified by a handle "name@<ref>" (copied verbatim from
   * list_team_peers).
   *
   * The handle's ref becomes the message's `ref_id`, which pins it to that
   * recipient session — the recipient's other sessions (different tasks) will
   * not see this message in inbox_check.
   *
   * Routing by recipient state:
   *   - active  → injectIntoChat (steer the live stream)
   *   - idle/offline → wake the recipient's task binding with a fresh turn;
   *     the woken agent reads us via `inbox_check`.
   *   - completed → not woken (the user explicitly stopped that session);
   *     left in inbox for next natural wake.
   *
   * Strict resolution: throws if the handle is malformed, the agent is
   * unknown, or no binding matches the ref. (No silent fallback; callers
   * should always discover handles via list_team_peers.)
   */
  async sendToAgent(input: {
    to: string
    content: string
  }): Promise<InboxSendResult> {
    const { agentName, issueIdentifier } = parseHandle(input.to)
    if (!agentName) {
      throw new Error(`Recipient handle is empty.`)
    }
    if (!issueIdentifier) {
      throw new Error(
        `Recipient must be a handle from list_team_peers in the form 'name@<ref>' (e.g. 'coder@task-7'). Got '${input.to}'.`,
      )
    }

    const target = this.storage.getAgentByName(agentName)
    if (!target) throw new Error(`Unknown agent: ${agentName}`)

    // Fallback matters when the sender's session key isn't in storage: 'task' is
    // the only scope that still produces bindings (was 'linear' before that
    // integration was retired, which would now match nothing and always throw).
    const scopeKind = this.senderBinding?.scopeKind ?? 'task'
    const recipient = this.storage
      .listBindings({ scopeKind, agentId: target.id })
      .find((b) => b.scopeDisplayName === issueIdentifier)
    if (!recipient) {
      throw new Error(
        `No session matches '${input.to}'. Call list_team_peers to see currently registered peers.`,
      )
    }

    const sender = this.storage.getAgent(this.senderAgentId)
    const senderName = sender?.name ?? `agent-${this.senderAgentId}`

    const row = this.storage.insertInboxMessage({
      recipientAgentId: target.id,
      senderAgentId: this.senderAgentId,
      senderName,
      content: input.content,
      refKind: 'channel_task',
      refId: issueIdentifier,
      metadata: null,
    })

    const notification =
      `[System notification: 1 new direct message from @${senderName} re ${issueIdentifier}. Call inbox_check to read.]`

    // Active path: steer the running stream.
    if (recipient.status === 'active' && recipient.activeChatId != null) {
      try {
        const res = await injectIntoChat(recipient.activeChatId, notification)
        if (res.success) {
          return { messageId: row.id, delivered: 'injected' }
        }
      } catch (err) {
        console.warn(`[Inbox] inject failed for binding=${recipient.id}:`, err)
        // Fall through to wake path — runtime may have just been disposed.
      }
    }

    // `completed` means the user explicitly stopped that session; don't resurrect.
    if (recipient.status === 'completed') {
      return { messageId: row.id, delivered: 'queued' }
    }

    // Wake the recipient's task binding (start a fresh turn so it reads
    // inbox_check).
    const woke = await wakeTaskBinding(recipient.id, notification)
    return { messageId: row.id, delivered: woke ? 'woken' : 'queued' }
  }

  /**
   * Read unread inbox messages for this agent's *current session* and
   * advance a per-session cursor. Returns only messages whose `ref_id` matches
   * the sender's scopeDisplayName (or is NULL — broadcast). Safe to call freely.
   */
  async inboxCheck(limit = 50): Promise<InboxMessageView[]> {
    const unread = this.storage.getUnreadInboxMessages(this.senderAgentId, {
      scopeDisplayName: this.senderScopeDisplayName,
      limit,
    })
    if (unread.length === 0) return []

    const cursorKey = this.senderScopeDisplayName ?? ''
    const maxId = unread[unread.length - 1].id
    this.storage.upsertCursor(this.senderAgentId, 'inbox', cursorKey, maxId)

    return unread.map((m) => this.format(m))
  }

  /**
   * Page through inbox history without advancing the cursor.
   * Returns newest-first.
   */
  async inboxReadHistory(opts: {
    peer?: string
    before?: number
    limit?: number
  }): Promise<InboxHistoryResult> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200))
    let senderAgentId: number | undefined
    if (opts.peer) {
      const a = this.storage.getAgentByName(opts.peer)
      if (!a) {
        return { messages: [], hasMore: false }
      }
      senderAgentId = a.id
    }
    const rows = this.storage.listInboxMessages(this.senderAgentId, {
      senderAgentId,
      beforeId: opts.before,
      limit: limit + 1,
    })
    const hasMore = rows.length > limit
    const slice = hasMore ? rows.slice(0, limit) : rows
    return {
      messages: slice.map((m) => this.format(m)),
      hasMore,
    }
  }

  /**
   * List active peers scoped to the same project AND the same
   * team_label. Inbox is opt-in via `team:<name>` — a binding without
   * teamLabel returns no peers (and shouldn't even reach this point, since
   * inbox MCP is not injected for those sessions).
   */
  async listTeamPeers(): Promise<TeamPeerView[]> {
    const senderBinding = this.senderBinding
    if (!senderBinding) return []
    if (!senderBinding.teamLabel) return []

    const projectId = senderBinding.projectId
    const teamLabel = senderBinding.teamLabel
    const peers = this.storage
      .listBindings({ scopeKind: senderBinding.scopeKind, projectId: projectId ?? undefined })
      .filter((b) => b.id !== senderBinding.id)
      .filter((b) => b.teamLabel === teamLabel)

    return peers.map((b) => {
      const agent = this.storage.getAgent(b.agentId)
      const name = agent?.name ?? `agent-${b.agentId}`
      const handle = b.scopeDisplayName ? `${name}@${b.scopeDisplayName}` : name
      return {
        handle,
        name,
        description: agent?.instructions ?? '',
        status: b.status,
        scopeDisplayName: b.scopeDisplayName,
        agentSessionId: b.agentSessionId,
      }
    })
  }

  /** Global agent directory — names + descriptions only. */
  async listAgents(): Promise<AgentDirectoryEntry[]> {
    return this.storage.listAgents().map((a) => ({
      name: a.name,
      description: a.instructions,
    }))
  }

  private format(m: {
    id: number
    senderName: string
    senderAgentId: number | null
    content: string
    refKind: string | null
    refId: string | null
    createdAt: number
  }): InboxMessageView {
    const time = new Date(m.createdAt).toISOString()
    const refSuffix = m.refKind && m.refId ? ` ref=${m.refKind}:${m.refId}` : ''
    return {
      id: m.id,
      senderName: m.senderName,
      senderAgentId: m.senderAgentId,
      content: m.content,
      ref: m.refKind && m.refId ? { kind: m.refKind, id: m.refId } : null,
      createdAt: m.createdAt,
      formatted: `[inbox id=${m.id} from=@${m.senderName} time=${time}${refSuffix}] ${m.content}`,
    }
  }
}
