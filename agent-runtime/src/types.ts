import type { TextStreamPart, ToolSet, UserModelMessage } from 'ai'

export interface DetailedContextUsageCategory {
  name: string
  tokens: number
  /**
   * The producer's own swatch id, in the producer's own vocabulary: the Claude SDK
   * sends its terminal palette, the Operon engine sends semantic names ('messages',
   * 'tools'). Two incompatible alphabets, and neither is theme-aware, so the panel
   * paints from `kind` plus row order instead of reading this. Kept because the wire
   * carries it and dropping it would be a breaking change for other consumers.
   */
  color: string
  isDeferred?: boolean
  /**
   * What the row is: 'used' content occupies the window, 'free' is what is left of
   * it, 'buffer' is the compaction reserve, and 'deferred' rows are out-of-window
   * tool schemas — listed for awareness, excluded from the usage math. Classify on
   * this, never on the English name. Optional so a producer predating it still
   * type-checks; consumers fall back to `isDeferred` and the name.
   */
  kind?: 'used' | 'free' | 'buffer' | 'deferred'
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

/** Map of server name → config, as handed to a provider via `SessionOptions.mcpServers`. */
export type RuntimeMcpServers = Record<string, RuntimeMcpServer>

/**
 * What every provider's session accepts. Native values (`mode`, `effort`) are
 * the agent's own ids — typed per provider through `createRuntime`, plain
 * strings to code that handles any provider. Provider-only settings come in a
 * block named after the provider (`codex: { … }`), see each provider's options.
 */
export interface SessionOptions<Mode extends string = string, Effort extends string = string> {
  cwd: string
  env?: Record<string, string | undefined>
  model?: string
  /** The agent's permission mode, in its own vocabulary (`describe()` lists them). */
  mode?: Mode
  /** Thinking effort, in the agent's own vocabulary. */
  effort?: Effort
  serviceTier?: ServiceTier
  /** Continue this provider-native session (Claude session id, Codex thread id, …). */
  resume?: string
  /**
   * MCP servers to expose to the underlying agent, already resolved by the host.
   * The host decides which servers to inject and bakes any identity into their
   * URLs; the provider only adapts this map to its own transport format.
   */
  mcpServers?: RuntimeMcpServers
  /**
   * Session-scoped extra instructions (agent persona, collaboration rules,
   * workflow prompts) layered on top of the agent's own system prompt. Pass it
   * on EVERY session creation — a resumed session does not get it back on its
   * own, and system-role input is ignored by the CLI agents. Each provider maps
   * it to its native mechanism: Claude `systemPrompt.append`, Codex
   * `developerInstructions`, Copilot `systemMessage.append`, OpenCode `system`,
   * an ACP first-prompt preamble.
   */
  instructions?: string
  /**
   * Branch this session off an existing one instead of starting fresh — what a
   * side chat is built on. The new session inherits the source's history as
   * model context but opens on a blank transcript, and diverges from that point
   * on: nothing said in either session afterwards reaches the other.
   *
   * Only honoured by providers that declare `features.sideChat`; others ignore
   * it and start a normal session. Applies to the FIRST thread this session
   * creates — once the session has an id it resumes it as usual, so a side chat
   * forks once, not on every turn.
   */
  fork?: RuntimeForkSource
  /**
   * False when no person is there to answer — a background task, a sub-agent in
   * a workflow. Providers then leave off the interactive callbacks that would
   * block on a question nobody sees (Copilot's ask_user and plan-exit
   * confirmation). Defaults to true.
   */
  interactive?: boolean
  /**
   * Directories outside `cwd` the agent may write to as freely as it writes
   * inside it — whatever its mode lets it do in `cwd` it may do here too.
   * Codex: the sandbox's writable roots; Claude: `additionalDirectories`.
   * Other providers ignore it, so a write there goes through their approvals.
   */
  writableDirs?: string[]
}

export interface RuntimeForkSource {
  /** Provider-native id of the session to branch from (the parent's thread). */
  from: string
  /** Branch after this turn instead of at the parent's tail. */
  afterTurn?: string
  /** Do not persist the fork as a resumable session. Side chats are ephemeral. */
  ephemeral?: boolean
}

/** One turn's input: text, or text plus images / files. */
export type AgentInput = string | Exclude<UserModelMessage['content'], string>

export interface SendOptions {
  signal?: AbortSignal
}

export interface InjectOptions {
  /** Caller's id for the message, echoed back on its `injected-input` part. */
  id?: string
}

export type RuntimeTextStreamPart = TextStreamPart<ToolSet>

export interface RuntimeMessageMetadataPart {
  type: 'message-metadata'
  metadata: Record<string, unknown>
}

/**
 * A message added with `inject` reached the agent, at this point in the stream:
 * whatever streamed before it, the agent wrote without having seen it. `id` is the
 * one passed to `inject`. Providers that cannot tell when that happens never emit it.
 */
export interface RuntimeInjectedInputPart {
  type: 'injected-input'
  id: string
  text: string
}

export type RuntimeStreamPart = RuntimeTextStreamPart | RuntimeMessageMetadataPart | RuntimeInjectedInputPart

/** Settings a live session can be asked to change without being rebuilt. */
export interface SessionPatch<Mode extends string = string, Effort extends string = string> {
  model?: string
  mode?: Mode
  effort?: Effort
  /**
   * Fast mode. Unlike the fields above, `undefined` here is a VALUE — it means
   * "not fast" — so a provider must test `'serviceTier' in patch` rather than
   * truthiness, or turning fast mode back off will silently do nothing.
   */
  serviceTier?: ServiceTier
}

/** Which requested fields the session actually applied — see `AgentSession.set`. */
export type SessionPatchApplied = Array<keyof SessionPatch>

/**
 * Why a session is being torn down.
 *
 * `'rebuild'` means the very same conversation is about to get a fresh session,
 * because something the runtime cannot change in place moved (e.g. the MCP map).
 * State the conversation still needs — a side chat's forked session, say —
 * must survive it. `'discard'` is the end of the conversation itself: the chat is
 * going away, and everything it owns can go with it.
 */
export type SessionCloseReason = 'discard' | 'rebuild'

/** A provider rejected injection before enqueueing or sending anything. Safe to retry later. */
export class RuntimeInjectionUnavailableError extends Error {}

/**
 * A sub-agent the session left running in the background (Claude Code's
 * `Agent` with `run_in_background`). Keyed for the UI by `toolUseId` — the
 * spawning tool call, which is the card it renders under.
 */
export interface RuntimeBackgroundTask {
  /** The provider's task id; for Claude Code this is also the sub-agent's transcript id. */
  taskId: string
  toolUseId: string
  description: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  /** Tool calls the sub-agent has made so far. */
  toolUses?: number
  lastToolName?: string
  /** A one-line progress summary while running; the final report once finished. */
  summary?: string
  startedAt: number
  endedAt?: number
}

/**
 * What a session does while no `send()` is open.
 *
 * `tasks` is a level signal: the session's whole background-task list after any
 * change, never a delta. `turn` is a reply the agent started on its own — Claude
 * Code answers a finished background agent without being asked — handed over as
 * the same parts a `send()` would yield, ending when the reply does.
 */
export type RuntimeBackgroundEvent =
  | { type: 'tasks'; tasks: RuntimeBackgroundTask[] }
  | { type: 'turn'; parts: AsyncIterable<RuntimeStreamPart> }

/** A persisted thread goal the agent pursues on its own (`features.goal`). */
export interface GoalControl {
  /** The current goal, or null when there is none. */
  get(): Promise<RuntimeGoal | null>
  /** Set the goal's status without starting a turn (e.g. pause). */
  setStatus(status: 'active' | 'paused'): Promise<RuntimeGoal | null>
  clear(): Promise<void>
  /**
   * Make `objective` the active goal and stream the autonomous pursuit — one or
   * more agent-initiated turns — until it is met, paused or the signal aborts.
   */
  run(objective: string, options?: SendOptions): AsyncIterable<RuntimeStreamPart>
}

/** One MCP server as a session sees it — what a Session panel lists. */
export interface McpServerInfo {
  name: string
  /** The provider's own status word: `connected`, `failed`, `needs-auth`, `disabled`, `pending`, … */
  status: string
  transport?: string
  error?: string
  toolCount?: number
}

/** Read-only MCP status (Codex). */
export interface McpStatusControl {
  list(): Promise<McpServerInfo[]>
}

/** MCP status plus live control (Claude Code, OpenCode). */
export interface McpControl extends McpStatusControl {
  reconnect(name: string): Promise<void>
  toggle(name: string, enabled: boolean): Promise<void>
}

/** What a session currently runs with, as it reports it. */
export type SessionState = Partial<
  Pick<
    ProviderDescriptor,
    'currentModelId' | 'currentModeId' | 'currentThinkingLevel' | 'currentServiceTier' | 'slashCommands'
  >
>

/**
 * A live conversation with one agent. Every provider implements the required
 * members; the optional ones follow the provider's `features`. `Native` is what
 * only this provider can do (see `native`).
 */
export interface AgentSession<Native = unknown> {
  /** The provider-native session id — known once the first turn starts. Store it, pass it back as `resume`. */
  readonly id: string | undefined
  /** Run one turn. The agent keeps its own history; pass only this turn's input. */
  send(input: AgentInput, options?: SendOptions): AsyncIterable<RuntimeStreamPart>
  abort(): void
  close(reason?: SessionCloseReason): Promise<void>
  /** Answer a `tool-approval-request`. True when it was still pending and the agent took the answer. */
  respond(approvalId: string, decision: PermissionDecision): boolean
  /**
   * Add a message to the turn that is running (`features.injection`). Throws
   * `RuntimeInjectionUnavailableError` when there is no turn to add it to.
   * With an `id`, the stream marks where the agent took the message in with an
   * `injected-input` part carrying that id (see `RuntimeInjectedInputPart`).
   */
  inject?(text: string, options?: InjectOptions): Promise<void>
  /**
   * Change model / permission mode / effort on a live session (`features.dynamicSwitch`).
   *
   * Returns the subset it actually applied in place. Support differs by provider,
   * so a caller tracking what a session runs with must record only what came back,
   * and rebuild for the rest.
   */
  set?(patch: SessionPatch): Promise<SessionPatchApplied>
  state?(): SessionState
  /** Where the context window is going, by category (`features.contextUsage`). */
  contextUsage?(): Promise<DetailedContextUsage | null>
  /** The thread goal (`features.goal`). */
  readonly goal?: GoalControl
  /**
   * Receive what the session does between turns (see `RuntimeBackgroundEvent`).
   * Without a listener a provider drops that output. Returns the unsubscribe.
   */
  onBackground?(listener: (event: RuntimeBackgroundEvent) => void): () => void
  /** What only this provider can do — MCP server control, sub-agent transcripts, … */
  readonly native?: Native
}

/**
 * A provider instance, as a provider implements it. `createSession` takes the
 * provider's full options (`SessionOptions` plus its own block); a method, so
 * instances with narrower options still fit the general type.
 */
export interface RuntimeProviderFactory<Options extends SessionOptions = SessionOptions, Native = unknown> {
  readonly providerInfo: ProviderInfo
  getDescriptor(): Promise<ProviderDescriptor>
  createSession(options: Options): Promise<AgentSession<Native>>
  /** Pre-fetch provider metadata (models, account, commands) without starting a session */
  fetchInitInfo?(): Promise<void>
}

export interface ProviderInfo {
  id: string
  label: string
  logo: string
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
