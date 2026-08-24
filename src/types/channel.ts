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
  createdAt: number
}

export interface CreateMessageInput {
  channelId: number
  threadRootId?: number | null
  senderType: MessageSenderType
  senderId?: number | null
  senderName: string
  content: string
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

export type BindingScopeKind = 'app' | 'slack' | 'telegram' | 'linear' | 'task'

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
  teamLabel: string | null
  metadata: Record<string, unknown> | null
  createdAt: number
  updatedAt: number
}

export type ChannelEvent =
  | { type: 'channel_message'; data: ChannelMessage }
  | { type: 'message_updated'; data: ChannelMessage }
  | { type: 'typing_start'; agentId: number }
  | { type: 'typing_stop'; agentId: number }
  | { type: 'agent_status'; agentId: number; projectId: number; status: AgentSessionStatus }
