export interface AgentEnvVar {
  key: string
  value: string
  enabled: boolean
}

export interface Agent {
  id: number
  name: string
  provider: string
  model: string
  instructions: string
  permissionMode: string
  /** Reasoning effort the agent's sessions run at; '' = the provider's default. */
  thinkingLevel: string
  canDelegate: boolean
  env: AgentEnvVar[]
  createdAt: number
}

export interface CreateAgentInput {
  name: string
  provider: string
  model: string
  instructions?: string
  permissionMode?: string
  thinkingLevel?: string
  canDelegate?: boolean
  env?: AgentEnvVar[]
}

/**
 * Provider is locked at create-time and cannot be updated. Switching providers
 * would orphan the native LLM session state (Claude SDK / Codex / Kimi). Server
 * rejects any update body containing `provider` with HTTP 400. To switch
 * provider, delete and recreate the agent.
 */
export interface UpdateAgentInput {
  name?: string
  model?: string
  instructions?: string
  permissionMode?: string
  canDelegate?: boolean
  env?: AgentEnvVar[]
}

export interface Channel {
  id: number
  projectId: number
  name: string
  description: string
  createdAt: number
}

export interface CreateChannelInput {
  projectId: number
  name: string
  description?: string
}

export interface ChannelMember {
  id: number
  channelId: number
  agentId: number
  joinedAt: number
}

export type MessageSenderType = 'human' | 'agent' | 'system'

/** An image on a channel message: a stored attachment (url = /api/attachments/<sha256>). */
export interface ChannelAttachment {
  url: string
  mediaType: string
  filename?: string
}

export interface ChannelMessage {
  id: number
  channelId: number
  threadRootId: number | null
  senderType: MessageSenderType
  senderId: number | null
  senderName: string
  content: string
  replyCount: number
  lastReplyAt: number | null
  /** The agent session that posted it (server-side bookkeeping); null for humans and older rows. */
  senderBindingId?: number | null
  /** Images on the message. Absent from servers that predate channel images. */
  attachments?: ChannelAttachment[]
  createdAt: number
}

/**
 * A thread is a unit of work under one root message, owned by the agent doing
 * it there (in a thread session of its own). `status` / `summary` are what the
 * owner last reported; whether it is working right now is `activeAgentIds`.
 *
 *   open    — nothing to report (just opened, in progress, or reopened by a reply)
 *   waiting — the owner needs a human decision or answer
 *   done    — the owner reported it finished
 */
export type ChannelThreadStatus = 'open' | 'waiting' | 'done'

export interface ChannelThread {
  rootMessageId: number
  channelId: number
  ownerAgentId: number | null
  status: ChannelThreadStatus
  summary: string
  createdByType: 'human' | 'agent'
  createdById: number | null
  createdAt: number
  updatedAt: number
  /** Agents with a session in the thread, and which of those are running now. */
  participantAgentIds: number[]
  activeAgentIds: number[]
  /** Sessions in the thread blocked on a person (an approval or a question). */
  waiting: WaitingSession[]
}

/**
 * An agent session blocked on a person. `chatId` is the session's chat — the
 * approval is answered against it; `approvalIds` change whenever what it waits
 * on does.
 */
export interface WaitingSession {
  agentId: number
  chatId: number
  approvalIds: string[]
}

export interface CreateMessageInput {
  channelId: number
  threadRootId?: number | null
  senderType: MessageSenderType
  senderId?: number | null
  senderName: string
  content: string
  attachments?: ChannelAttachment[]
}

export type AgentSessionStatus = 'offline' | 'idle' | 'active'

export interface AgentSession {
  id: number
  agentId: number
  projectId: number
  workspaceId: number | null
  chatId: number | null
  status: AgentSessionStatus
  updatedAt: number
}

export type BindingScopeKind = 'app' | 'slack' | 'telegram' | 'linear' | 'task' | 'thread'

export type BindingStatus = 'offline' | 'idle' | 'active' | 'completed'

/**
 * Unified agent binding — one runtime instance of an agent attached to a
 * specific surface (internal channel / Slack channel / TG chat / Linear issue).
 * Returned by GET /agents/:id/sessions.
 */
export interface AgentBinding {
  id: number
  agentId: number
  scopeKind: BindingScopeKind
  scopeKey: string
  scopeDisplayName: string | null
  channelKind: 'channel' | 'dm'
  projectId: number | null
  workspaceId: number | null
  activeChatId: number | null
  status: BindingStatus
  imProviderInstanceId: number | null
  agentSessionId: string | null
  metadata: Record<string, unknown> | null
  createdAt: number
  updatedAt: number
}

export type ThreadRootActivity = Pick<ChannelMessage, 'id' | 'replyCount' | 'lastReplyAt'>

export type ChannelEvent =
  | { type: 'channel_message'; data: ChannelMessage; threadRoot?: ThreadRootActivity }
  | { type: 'message_updated'; data: ChannelMessage }
  | { type: 'thread_updated'; data: ChannelThread }
  | { type: 'sessions_waiting'; data: WaitingSession[] }
  | { type: 'typing_start'; agentId: number }
  | { type: 'typing_stop'; agentId: number }
  | { type: 'agent_status'; agentId: number; projectId: number; status: AgentSessionStatus }
