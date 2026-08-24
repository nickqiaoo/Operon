/**
 * Unified agent binding model.
 * Replaces AgentSession (channel) + IMChannelBinding (mate); also covers Linear.
 */

export type BindingScopeKind = 'app' | 'slack' | 'telegram' | 'linear' | 'task'

export type BindingChannelKind = 'channel' | 'dm'

export type BindingStatus = 'offline' | 'idle' | 'active' | 'completed'

export interface AgentBinding {
  id: number
  agentId: number

  scopeKind: BindingScopeKind
  /**
   * scope_key encoding by scopeKind:
   *   app    → String(channel.id)
   *   slack  → source_channel (Slack channel id)
   *   telegram → source_channel (TG chat id)
   *   linear → Linear agent_session_id (also stored in agent_session_id col)
   */
  scopeKey: string
  scopeDisplayName: string | null
  channelKind: BindingChannelKind

  projectId: number | null
  workspaceId: number | null
  activeChatId: number | null
  status: BindingStatus

  /** Mate-only: which IM provider instance (Slack/TG bot) serves this binding. */
  imProviderInstanceId: number | null
  /** Linear-only: external Linear agentSession id. */
  agentSessionId: string | null
  /** Linear-only: team label for inbox peer scoping. */
  teamLabel: string | null

  /**
   * Scope-specific extension fields (low-frequency; hot fields are own columns).
   *   slack/tg: { selfUserId?, selfBotId? }
   *   linear:   { linearIssueId?, linearIssueIdentifier?, linearOrgId? }
   */
  metadata: Record<string, unknown> | null

  createdAt: number
  updatedAt: number
}

export interface UpsertAgentBindingInput {
  agentId: number
  scopeKind: BindingScopeKind
  scopeKey: string
  scopeDisplayName?: string | null
  channelKind?: BindingChannelKind
  projectId?: number | null
  workspaceId?: number | null
  activeChatId?: number | null
  status?: BindingStatus
  imProviderInstanceId?: number | null
  agentSessionId?: string | null
  teamLabel?: string | null
  metadata?: Record<string, unknown> | null
}

export interface UpdateAgentBindingInput {
  scopeDisplayName?: string | null
  projectId?: number | null
  workspaceId?: number | null
  activeChatId?: number | null
  status?: BindingStatus
  imProviderInstanceId?: number | null
  agentSessionId?: string | null
  teamLabel?: string | null
  metadata?: Record<string, unknown> | null
}

export interface ListBindingsQuery {
  scopeKind?: BindingScopeKind
  agentId?: number
  projectId?: number
  imProviderInstanceId?: number
  teamLabel?: string
  status?: BindingStatus
}

// ---------- Cursor ----------

export type CursorStreamKind = 'app' | 'mate' | 'inbox'

export interface AgentMessageCursor {
  agentId: number
  streamKind: CursorStreamKind
  streamKey: string
  lastReadId: number
  updatedAt: number
}

// ---------- Inbox ----------

export type InboxRefKind = 'linear_issue' | 'channel_task'

export interface AgentInboxMessageRow {
  id: number
  recipientAgentId: number
  senderAgentId: number | null
  senderName: string
  content: string
  refKind: InboxRefKind | null
  refId: string | null
  metadata: Record<string, unknown> | null
  createdAt: number
}

export interface CreateAgentInboxMessageInput {
  recipientAgentId: number
  senderAgentId?: number | null
  senderName: string
  content: string
  refKind?: InboxRefKind | null
  refId?: string | null
  metadata?: Record<string, unknown> | null
}
