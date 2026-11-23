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
  /** Hidden from user-facing agent pickers (channel member list, dispatch assignee, @mention).
   *  Used for the implicit `Workspace Assistant` a direct workspace chat acts as. */
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
  thinkingLevel?: string
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
  thinkingLevel?: string
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
  /** The agent session (binding) that posted it; null for humans, system notices and older rows. */
  senderBindingId: number | null
  attachments: ChannelAttachment[]
  createdAt: number
}

export interface CreateMessageInput {
  channelId: number
  threadRootId?: number | null
  senderType: MessageSenderType
  senderId?: number | null
  senderName: string
  content: string
  senderBindingId?: number | null
  attachments?: ChannelAttachment[]
}

/**
 * A thread is a unit of work hanging off one root message. Its owner's thread
 * session does the work there; `status`/`summary` are what that session last
 * reported (update_thread). Whether it is running right now is not stored — it
 * is the thread bindings' live status (see ChannelThreadView).
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
}

/**
 * A session (channel or thread) that is blocked on a person: a tool approval or
 * a question. `chatId` is the session's chat, which the approval is answered
 * against (POST /api/ai/permission-response); `approvalIds` change whenever
 * what it waits on does.
 */
export interface WaitingSession {
  agentId: number
  chatId: number
  approvalIds: string[]
}

/** A thread as the UI sees it: the row plus which agents have a session in it, which are running, and which wait on someone. */
export interface ChannelThreadView extends ChannelThread {
  participantAgentIds: number[]
  activeAgentIds: number[]
  waiting: WaitingSession[]
}

/** Aggregate status emitted on the project channel-bus. Per-binding status
 * (now stored in agent_bindings.status) is mapped to this string for UI. */
export type AgentSessionStatus = 'offline' | 'idle' | 'active'
