import type { UIMessage } from 'ai'
import type { ChatType } from '../../types/chat.js'

export interface AiChatRequest {
  requestId?: string
  chatId?: number
  messages: UIMessage[]
  modelId?: string
  modeId?: string
  thinkingLevel?: string
  serviceTier?: 'fast'
  providerId?: string
  workspaceId?: number
  /** When true, the latest user message is set as an active thread goal (codex). */
  asGoal?: boolean
  tp?: ChatType
  skipSnapshot?: boolean
  /**
   * Which first-party agent-comm MCP servers this session gets, and the context
   * they need. Absent for plain chat sessions (cronjob / canvas / interactive IM).
   */
  agentContext?: AgentMcpContext
  /**
   * Session-scoped instructions (agent persona / collaboration rules) layered
   * onto the provider's own system prompt. Callers must re-derive and pass this
   * on EVERY startChat — providers bake it at session creation and resume does
   * not restore a previous value. Do NOT send it as a system-role message; the
   * runtime providers ignore those.
   */
  instructions?: string
  /**
   * Extra environment variables to merge into the runtime env on session
   * start. Bakes in at session creation time — toggling values mid-session
   * has no effect; caller must Reset the session for changes to apply.
   */
  env?: Record<string, string>
}

/**
 * The agent-comm MCP context for a session. Each field drives one first-party
 * MCP server's mounting/config; forwarded as a unit to buildMcpServersForCli.
 */
export interface AgentMcpContext {
  /**
   * Workspace directory this session runs in. Baked into the Workflow MCP URL so
   * the tool's sub-agent dispatch knows where to spawn provider sessions. Set by
   * chat-flow at session-build time (it has the resolved cwd in scope).
   */
  cwd?: string
  /**
   * The operon conversation this session belongs to (= `chats.id`). Injects the
   * node_repl MCP (Computer Use / Browser Use) and scopes it: node_repl forks a
   * kernel per session, and the kernel keeps `globalThis` across turns (that is
   * how `agent.browsers` is reused), so two conversations must never share one.
   *
   * It is also what Browser Use reports as `operonSessionId`, which is how the
   * IAB backend keeps each conversation's browser tabs apart.
   */
  chatId?: number
  /** With projectId, injects the workspace chat + task board MCP. */
  agentId?: number
  projectId?: number
  /** True for a mate/IM-bridge session: injects the IM chat MCP instead of workspace chat/task board. */
  imBridge?: boolean
  /**
   * Channel this session is bound to (channel-scoped agent sessions). Threaded
   * to the taskboard MCP so SDD `create_spec_task` derives its channel from the
   * session context instead of trusting a model-supplied id.
   */
  channelId?: number
  /**
   * Direct workspace chat this session IS (interactive user chat). Threaded to
   * the taskboard MCP as the alternative SDD promote source: `create_spec_task`
   * turns this chat into a spec-driven task when there's no channel. Mutually
   * exclusive with channelId. When set, the session is given the taskboard MCP
   * (but not workspace_chat) and the SDD create-spec hint.
   */
  sourceChatId?: number
  /**
   * When set (with agentId), injects the team inbox MCP for agent-to-agent
   * messaging. Value is the sender binding's session key.
   */
  inboxAgentSessionId?: string
}

export interface ChatRecordState {
  chatId: number
  baseRevision: number
  sessionId?: string
}

export type ApprovalResponseSnapshot = {
  approvalId: string
  approved: boolean
  reason?: string
  state: string
}

export type AssistantContinuationState = {
  assistantIndex: number
  assistantMessage: UIMessage
}

export type PreparedMetadataState = {
  hasExplicitMetadata: boolean
}

export interface StartChatOptions {
  /** Merged into the persisted assistant message's metadata. Used by compact to
   *  stamp `{ compact: true }` on the summary message so it can be located later. */
  assistantMetadata?: Record<string, unknown>
  /** When true, the user message is NOT persisted to DB before streaming.
   *  Only the assistant response is saved (via persistAssistantMessageWithRetry).
   *  This prevents orphaned user messages if the stream fails mid-way —
   *  used by compact to avoid leaving a huge prompt in DB on partial failure. */
  skipUserMessagePersistence?: boolean
  /** Raise user-inbox notifications for this turn (pending approvals →
   *  chat_needs_input). Set only by the user-facing workspace-chat path
   *  (handleChat) — background turns (cron/canvas/channel/task) stay silent. */
  notifyInbox?: boolean
}

export interface CompactRequest {
  chatId: number
  modelId: string
  providerId?: string
  workspaceId?: number
}

export type PermissionOutcomeKind = 'allow' | 'deny' | 'allowAlways'

export type PermissionOutcome =
  | PermissionOutcomeKind
  | { outcome: PermissionOutcomeKind; reason?: string; updatedInput?: Record<string, unknown> }

export type FileMessagePartWithContent = Extract<UIMessage['parts'][number], { type: 'file' }> & {
  content?: string
}
