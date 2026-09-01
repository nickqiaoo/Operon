import type { ModelMessage, TextStreamPart, ToolSet } from 'ai'

export interface DetailedContextUsageCategory {
  name: string
  tokens: number
  /** Swatch the UI may paint the row with. Free-form; the panel currently ignores it. */
  color: string
  isDeferred?: boolean
}

/**
 * Where a conversation's context window is going, broken down by category.
 *
 * Deliberately NOT the Claude SDK's `SDKControlGetContextUsageResponse`, which this
 * used to alias: that shape carries fields only Claude Code can fill (`gridRows`,
 * `agents`, per-server `mcpTools`, …), so no other provider could satisfy it. This is
 * the subset the panel actually renders, chosen so a Claude SDK response still assigns
 * to it unchanged while the Operon agent can build one from its own breakdown.
 */
export interface DetailedContextUsage {
  categories: DetailedContextUsageCategory[]
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  /** 0-100. */
  percentage: number
  model: string
  memoryFiles: { path: string; type: string; tokens: number }[]
  isAutoCompactEnabled: boolean
  autoCompactThreshold?: number
  apiUsage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null
}

export interface RuntimeUsageLimitWindow {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  /** Percent of the window consumed (0-100). */
  utilization?: number
  /** Epoch timestamp when the window resets (seconds or milliseconds). */
  resetsAt?: number
}

export interface RuntimeUsageLimits {
  windows: Record<string, RuntimeUsageLimitWindow>
  subscriptionType?: string
}

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface Model {
  id: string
  name: string
  description?: string
  providerId?: string
  providerLabel?: string
  providerLogo?: string
  /** Effort (thinking) levels this model supports. Empty array = no thinking. */
  supportedEffortLevels?: EffortLevel[]
  /** Total context window in tokens, when the provider advertises one. */
  contextWindow?: number
  /** Whether this model supports the 'auto' permission mode. */
  supportsAutoMode?: boolean
  /** Whether this model supports fast mode (serviceTier='fast'). */
  supportsFastMode?: boolean
  /** Whether this model supports adaptive thinking (Claude decides depth). */
  supportsAdaptiveThinking?: boolean
}

export interface Mode {
  id: string
  name: string
  description?: string
}

export interface ThinkingLevel {
  id: string
  name: string
}

export type ServiceTier = 'fast'

export interface ServiceTierOption {
  id: ServiceTier
  name: string
  description?: string
}

export interface Command {
  id: string
  name: string
  description?: string
  args?: CommandArg[]
}

export interface CommandArg {
  name: string
  required: boolean
  description?: string
}

export interface ProviderSkill {
  name: string
  description: string
}

export interface SlashCommandItem {
  name: string
  description: string
  type: 'skill' | 'command'
}

export interface ProviderFeatures {
  permissions: boolean
  attachments: boolean
  injection: boolean
  sessionResume: boolean
  checkpoint?: boolean
  /** Provider supports a persisted thread goal (set/get/clear + autonomous pursuit). */
  goal?: boolean
  /**
   * Provider honours `RuntimeSessionParams.forkFrom`, so a session can branch off
   * another one's history. Gates the side chat UI — without a real fork the only
   * alternative is replaying the parent transcript as fresh input, which costs a
   * full context every time.
   */
  sideChat?: boolean
  /**
   * Provider implements `RuntimeSession.dynamicSet`, so model / permission mode can
   * be switched on a live session — including mid-stream, which is what lets the UI
   * keep those pickers enabled while a turn is running.
   */
  dynamicSwitch?: boolean
  /**
   * Provider implements `RuntimeSession.getContextUsage`, so the usage panel can show
   * a per-category breakdown of the context window instead of raw token counts.
   */
  contextUsage?: boolean
}

/** Provider-agnostic view of a thread goal surfaced to routes/clients. */
export interface RuntimeGoal {
  objective: string
  status: string
  tokenBudget?: number | null
  tokensUsed?: number
  timeUsedSeconds?: number
}

export interface ProviderAccountInfo {
  email?: string
  organization?: string
  subscriptionType?: string
  apiProvider?: string
}

export interface ProviderDescriptor {
  id: string
  label: string
  logo: string

  models: Model[]
  /** True while a background provider probe is still resolving the live list. */
  modelsPending?: boolean
  modes: Mode[]
  thinkingLevels?: ThinkingLevel[]
  serviceTiers?: ServiceTierOption[]
  commands: Command[]
  skills?: ProviderSkill[]
  slashCommands?: SlashCommandItem[]

  currentModelId: string
  currentModeId: string
  currentThinkingLevel?: string
  currentServiceTier?: ServiceTier

  features: ProviderFeatures
  account?: ProviderAccountInfo
}

export type PermissionDecision =
  | { type: 'allow'; updatedInput?: Record<string, unknown> }
  | { type: 'deny'; reason?: string }
  | { type: 'allow-always'; updatedInput?: Record<string, unknown> }

/** A single MCP server the host asks the provider to expose (transport-agnostic). */
export type RuntimeMcpServer =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }

/** Map of server name → config, as handed to a provider via RuntimeSessionParams. */
export type RuntimeMcpServers = Record<string, RuntimeMcpServer>

export interface RuntimeSessionParams {
  cwd: string
  env?: Record<string, string | undefined>
  modelId?: string
  providerId?: string
  modeId?: string
  thinkingLevel?: string
  serviceTier?: ServiceTier
  sessionId?: string
  /**
   * MCP servers to expose to the underlying agent, already resolved by the host.
   * Provider-agnostic: the host decides which servers (workspace chat, task board,
   * IM bridge, team inbox, memory, cross-agent, user-configured) to inject and
   * bakes any identity into the server URLs; the provider only adapts this map to
   * its own transport format. Undefined when the host injects nothing.
   */
  mcpServers?: RuntimeMcpServers
  /**
   * Session-scoped extra instructions (agent persona, collaboration rules,
   * workflow prompts) layered on top of the provider's own system prompt.
   * The host re-derives and passes this on EVERY session creation — providers
   * must not expect it to arrive via `messages` (system-role messages are
   * ignored by the CLI-agent providers). Each provider maps it to its native
   * mechanism: Claude `systemPrompt.append`, Codex `developerInstructions`,
   * Gemini `userMemory`, Copilot `systemMessage.append`, ACP first-prompt
   * preamble.
   */
  instructions?: string
  /**
   * Set by the worker pool when spawning a sub-agent session (e.g. for the
   * Workflow tool's agent() fan-out). Worker sessions do not get their own
   * orchestration tools, preventing unbounded workflow-within-workflow nesting.
   */
  isWorker?: boolean
  /**
   * Branch this session off an existing one instead of starting fresh — what a
   * side chat is built on. The new session inherits the source's history as
   * model context but opens on a blank transcript, and diverges from that point
   * on: nothing said in either session afterwards reaches the other.
   *
   * Only honoured by providers that declare `features.sideChat`; others ignore
   * it and start a normal session. Applies to the FIRST thread this session
   * creates — once `sessionId` is known the session resumes it as usual, so a
   * side chat forks once, not on every turn.
   */
  forkFrom?: RuntimeForkSource
}

export interface RuntimeForkSource {
  /** Provider-native id of the session to branch from (the parent's thread). */
  sessionId: string
  /** Branch after this turn instead of at the parent's tail. */
  lastTurnId?: string
  /** Do not persist the fork as a resumable session. Side chats are ephemeral. */
  ephemeral?: boolean
}

export interface RuntimeStreamParams {
  requestId: string
  messages: ModelMessage[]
  signal?: AbortSignal
  /**
   * When true, the latest user message is treated as a goal objective: the
   * runtime sets an active thread goal and streams the autonomous pursuit
   * (one or more codex-initiated turns) instead of starting a normal turn.
   */
  asGoal?: boolean
}

export type RuntimeTextStreamPart = TextStreamPart<ToolSet>

export interface RuntimeMessageMetadataPart {
  type: 'message-metadata'
  metadata: Record<string, unknown>
}

export type RuntimeStreamPart = RuntimeTextStreamPart | RuntimeMessageMetadataPart

/** Settings a live session can be asked to change without being rebuilt. */
export interface DynamicSetPayload {
  modelId?: string
  modeId?: string
  thinkingLevel?: string
  /**
   * Fast mode. Unlike the fields above, `undefined` here is a VALUE — it means
   * "not fast" — so a provider must test `'serviceTier' in payload` rather than
   * truthiness, or turning fast mode back off will silently do nothing.
   */
  serviceTier?: ServiceTier
}

/** Which requested fields the session actually applied — see `RuntimeSession.dynamicSet`. */
export type DynamicSetApplied = Array<keyof DynamicSetPayload>

/**
 * Why a session is being torn down.
 *
 * `'rebuild'` means the very same conversation is about to get a fresh session,
 * because something the runtime cannot change in place moved (fast mode, the MCP
 * map). State the conversation still needs — a side chat's forked session, say —
 * must survive it. `'discard'` is the end of the conversation itself: the chat is
 * going away, and everything it owns can go with it.
 */
export type SessionDisposeReason = 'discard' | 'rebuild'

export interface RuntimeSession {
  stream(params: RuntimeStreamParams): AsyncIterable<RuntimeStreamPart>
  abort(): void
  dispose(reason?: SessionDisposeReason): Promise<void>
  /** True when this approval was still pending and accepted by the runtime. */
  resolvePermission(approvalId: string, decision: PermissionDecision): boolean
  getSessionId?(): string | undefined
  injectMessage?(content: string): Promise<void>
  /** Read the current thread goal (null when none / unsupported). */
  getGoal?(): Promise<RuntimeGoal | null>
  /** Set the thread-goal status without streaming (e.g. pause). */
  setGoalStatus?(status: 'active' | 'paused'): Promise<RuntimeGoal | null>
  /** Clear the thread goal. */
  clearGoal?(): Promise<void>
  /**
   * Change model / permission mode / thinking effort on a live session.
   *
   * Returns the subset it actually applied in place. Support is uneven — Claude's
   * SDK, for instance, can `setModel` and `setPermissionMode` on a running query
   * but has no setter for effort — and the caller uses the answer to keep the
   * session-reuse fingerprint honest. Claiming a field that did not take would
   * leave the record describing a session that never changed, and the switch
   * would silently do nothing.
   */
  dynamicSet?(payload: DynamicSetPayload): Promise<DynamicSetApplied>
  getDescriptorPatch?(): Partial<
    Pick<
      ProviderDescriptor,
      'currentModelId' | 'currentModeId' | 'currentThinkingLevel' | 'currentServiceTier' | 'slashCommands'
    >
  >
  getContextUsage?(): Promise<DetailedContextUsage | null>
  /**
   * Session runtime control surfaced to the chat UI's Session panel. Providers
   * implement the methods they support (for example MCP control on Claude Code
   * and OpenCode, read-only MCP status on Codex, or MCP / cron / tasks / skills
   * on the Operon agent).
   */
  agentControl?(method: string, params: unknown): Promise<unknown>
}

export interface RuntimeProviderFactory {
  readonly providerInfo: ProviderInfo
  getDescriptor(): Promise<ProviderDescriptor>
  createSession(params: RuntimeSessionParams): Promise<RuntimeSession>
  /** Pre-fetch provider metadata (models, account, commands) without starting a session */
  fetchInitInfo?(): Promise<void>
}

export interface ProviderInfo {
  id: string
  label: string
  logo: string
}

export interface ActiveRequest {
  requestId: string
  abortController: AbortController
}

export interface SessionRecord {
  chatId: number
  providerId: string
  runtime: RuntimeSession
  params: RuntimeSessionParams
  createdAt: number
  activeRequest: ActiveRequest | null
}

/**
 * An error whose message is written for the user rather than for a log.
 *
 * The AI SDK replaces stream errors with a generic notice, which is right for
 * internal failures but wrong for the few we author deliberately — "this side
 * chat expired", say. Hosts forward the message of these and mask everything
 * else, so a provider can speak to the user without opening a channel for
 * arbitrary internals to leak out.
 */
export class UserFacingRuntimeError extends Error {
  readonly userFacing = true as const

  constructor(message: string) {
    super(message)
    this.name = 'UserFacingRuntimeError'
  }
}

export function isUserFacingRuntimeError(error: unknown): error is UserFacingRuntimeError {
  return (
    error instanceof Error &&
    (error as { userFacing?: unknown }).userFacing === true
  )
}
