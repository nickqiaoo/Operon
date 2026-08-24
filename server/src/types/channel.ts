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
  /** Hidden from user-facing agent pickers (channel member list, dispatch assignee, @mention).
   *  Used for the implicit `Workspace Assistant` spec author of chat-sourced SDD tasks. */
  hidden: boolean
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
  hidden?: boolean
  env?: AgentEnvVar[]
}

/**
 * Provider is locked at create-time and cannot be updated. Switching providers
 * would orphan the LLM-native session state (Claude SDK sessions, Codex session
 * files, Kimi --session ids) which the runtime layer can't migrate. To "switch"
 * an agent's provider, delete and recreate the agent.
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

/** Aggregate status emitted on the project channel-bus. Per-binding status
 * (now stored in agent_bindings.status) is mapped to this string for UI. */
export type AgentSessionStatus = 'offline' | 'idle' | 'active'
