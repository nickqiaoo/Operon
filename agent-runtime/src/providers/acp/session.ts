import { randomUUID } from 'node:crypto'
import type * as acp from '@agentclientprotocol/sdk'
import type { RuntimeContext } from '../../context.js'
import { createRuntimeLogger } from '../../logger.js'
import type {
  AgentInput,
  AgentSession,
  PermissionDecision,
  SessionState,
  RuntimeMcpServers,
  RuntimeStreamPart,
  SendOptions,
  SessionOptions,
  SessionPatch,
  SessionPatchApplied,
  SlashCommandItem,
} from '../../types.js'
import { UserFacingRuntimeError } from '../../types.js'
import { toUserMessages } from '../../utils/agent-input.js'
import { AsyncQueue } from './async-queue.js'
import { toSlashCommands } from './commands.js'
import { configValues, findConfigOption, thinkingConfig } from './config-options.js'
import type { AcpConnection, AcpSessionCallbacks } from './connection.js'
import { acquireAcpConnection, disposeAllAcpConnections } from './connection-registry.js'
import { AcpEventMapper } from './event-mapper.js'
import { convertToAcpPrompt, prependTextToPrompt } from './message-mapper.js'
import type { AcpProviderConfig } from './types.js'

interface PendingDecision {
  resolve: (response: acp.RequestPermissionResponse) => void
  options: acp.PermissionOption[]
}

/** Convert the host's transport-agnostic MCP map into ACP `McpServer[]`. */
export function toAcpMcpServers(servers?: RuntimeMcpServers): acp.McpServer[] {
  if (!servers) return []
  const out: acp.McpServer[] = []
  for (const [name, entry] of Object.entries(servers)) {
    if (!entry.type || entry.type === 'stdio') {
      out.push({
        name,
        command: entry.command,
        args: entry.args ?? [],
        env: Object.entries(entry.env ?? {}).map(([envName, value]) => ({ name: envName, value })),
      })
    } else if (entry.type === 'http') {
      out.push({
        name,
        type: 'http',
        url: entry.url,
        headers: Object.entries(entry.headers ?? {}).map(([headerName, value]) => ({ name: headerName, value })),
      })
    } else if (entry.type === 'sse') {
      out.push({
        name,
        type: 'sse',
        url: entry.url,
        headers: Object.entries(entry.headers ?? {}).map(([headerName, value]) => ({ name: headerName, value })),
      })
    }
  }
  return out
}

/** Pick the ACP permission optionId that matches an operon PermissionDecision. */
function selectPermissionOption(
  options: acp.PermissionOption[],
  decision: PermissionDecision,
): string | undefined {
  const byKind = (kind: acp.PermissionOption['kind']) => options.find((o) => o.kind === kind)?.optionId
  if (decision.type === 'allow') {
    return byKind('allow_once') ?? byKind('allow_always') ?? options.find((o) => o.kind.startsWith('allow'))?.optionId
  }
  if (decision.type === 'allow-always') {
    return byKind('allow_always') ?? byKind('allow_once') ?? options.find((o) => o.kind.startsWith('allow'))?.optionId
  }
  return byKind('reject_once') ?? byKind('reject_always') ?? options.find((o) => o.kind.startsWith('reject'))?.optionId
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    const message = error.message
    if (typeof message === 'string' && message.trim()) return message
  }
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

export function normalizeAcpError(error: unknown): Error {
  return error instanceof Error ? error : new Error(describeError(error))
}

export class AcpRuntimeSession implements AgentSession {
  private readonly logger
  private readonly cwd: string
  private readonly env: Record<string, string>
  private readonly mcpServers: acp.McpServer[]
  private currentModelId: string
  private currentModeId: string
  private configOptions: acp.SessionConfigOption[] | undefined
  private readonly initialOptions: Pick<SessionOptions, 'model' | 'mode' | 'effort'>
  /** Session instructions (persona) from the host — prepended to the first prompt. */
  private readonly instructions: string | undefined

  private connection: AcpConnection | null = null
  /** Detaches this conversation's callbacks from the shared connection. */
  private unregisterSession: (() => void) | null = null
  /** Releases this session's hold on the shared agent process. */
  private connectionLease: (() => void) | null = null
  private sessionId: string | undefined
  private initPromise: Promise<void> | null = null
  private activeQueue: AsyncQueue<RuntimeStreamPart> | null = null
  private activeMapper: AcpEventMapper | null = null
  private didPrependInstructions = false
  private readonly pendingDecisions = new Map<string, PendingDecision>()
  /** Advertised context window per model id, read off the initialize handshake. */
  private contextWindows = new Map<string, number>()
  /** Latest `available_commands_update`, surfaced through getDescriptorPatch. */
  private slashCommands: SlashCommandItem[] = []

  constructor(
    params: SessionOptions,
    private readonly config: AcpProviderConfig,
    private readonly ctx: RuntimeContext,
  ) {
    this.logger = createRuntimeLogger(`${config.providerId}-runtime`)
    this.initialOptions = { model: params.model, mode: params.mode, effort: params.effort }
    this.cwd = params.cwd
    const env = ctx.env(params.env)
    this.env = config.patchEnv ? config.patchEnv(env) : env
    this.mcpServers = toAcpMcpServers(params.mcpServers)
    this.currentModelId = params.model ?? config.defaultModelId
    this.currentModeId = params.mode ?? config.defaultModeId
    this.instructions = params.instructions?.trim() || undefined
    // The host stores whatever `getSessionId()` reported for a chat and hands it
    // back here on the next run. Holding it before `connect()` is what lets the
    // session resume the agent's own history instead of starting a blank one.
    this.sessionId = params.resume
  }

  get id(): string | undefined {
    return this.sessionId
  }

  state(): SessionState {
    return {
      ...(this.configOptions !== undefined ? thinkingConfig(this.configOptions) : {}),
      currentModelId: this.currentModelId,
      currentModeId: findConfigOption(this.configOptions ?? [], 'mode')?.currentValue ?? this.activeMapper?.getCurrentModeId() ?? this.currentModeId,
      // Only override the descriptor's static list once the agent has actually
      // told us its commands; an empty patch would blank the menu.
      ...(this.slashCommands.length > 0 ? { slashCommands: this.slashCommands } : {}),
    }
  }

  send(input: AgentInput, options?: SendOptions): AsyncIterable<RuntimeStreamPart> {
    return this.runTurn(input, options?.signal)
  }

  private async *runTurn(input: AgentInput, signal: AbortSignal | undefined): AsyncIterable<RuntimeStreamPart> {
    if (this.activeQueue) {
      throw new Error(`A ${this.config.label} turn is already in progress`)
    }

    await this.ensureConnected()

    const conversion = convertToAcpPrompt(toUserMessages(input))
    if (conversion.warnings.length > 0) {
      for (const warning of conversion.warnings) this.logger.warn(`[message-mapper] ${warning.message}`)
    }
    // ACP has no system-prompt channel, so session instructions ride as a
    // preamble on the first prompt — that puts them in the agent's own history,
    // so they survive its session persistence without re-sending.
    //
    // A resumed session re-sends it anyway (this flag is per-instance, and a
    // resume builds a new one). That is the deliberate choice: the duplicate
    // costs a few hundred tokens of identical instructions, while skipping it
    // would silently drop the persona whenever an agent's `session/load`
    // restores visible turns but not the preamble — and would also pin the chat
    // to the persona it was created with, ignoring later edits.
    if (!this.didPrependInstructions) {
      if (this.instructions) conversion.prompt = prependTextToPrompt(conversion.prompt, this.instructions)
      this.didPrependInstructions = true
    }

    const queue = new AsyncQueue<RuntimeStreamPart>()
    const mapper = new AcpEventMapper(
      this.sessionId ?? '',
      this.currentModelId,
      conversion.warnings.map((w) => w.message),
      this.config.parseUsage,
      this.config.parseContextTokens,
      this.contextWindows.get(this.currentModelId),
    )
    this.activeQueue = queue
    this.activeMapper = mapper

    queue.push({ type: 'start' })
    for (const part of mapper.startStep()) queue.push(part)

    const handleAbort = () => this.abort()
    signal?.addEventListener('abort', handleAbort, { once: true })

    const promptPromise = this.runPrompt(conversion.prompt, mapper, queue).finally(() => {
      signal?.removeEventListener('abort', handleAbort)
      if (this.activeQueue === queue) this.activeQueue = null
      if (this.activeMapper === mapper) this.activeMapper = null
      queue.close()
    })

    try {
      for await (const part of queue) yield part
      await promptPromise
    } finally {
      signal?.removeEventListener('abort', handleAbort)
    }
  }

  private async runPrompt(
    prompt: acp.ContentBlock[],
    mapper: AcpEventMapper,
    queue: AsyncQueue<RuntimeStreamPart>,
  ): Promise<void> {
    const connection = this.connection
    if (!connection || !this.sessionId) {
      queue.push({ type: 'error', error: new Error(`${this.config.label} runtime is not initialized`) })
      return
    }
    try {
      this.logger.info(`Prompting ${this.config.providerId} session ${this.sessionId} (model=${this.currentModelId}, mode=${this.currentModeId})`)
      const result = await connection.agent.prompt({ sessionId: this.sessionId, prompt })
      for (const part of mapper.finalize(result.stopReason, result._meta ?? undefined)) queue.push(part)
    } catch (error) {
      this.logger.error(`Prompt failed for ${this.config.providerId} session ${this.sessionId}: ${describeError(error)}`)
      queue.push({ type: 'error', error: normalizeAcpError(error) })
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.initPromise) return this.initPromise
    if (this.connection && this.sessionId) return
    if (!this.initPromise) this.initPromise = this.connect()
    await this.initPromise
  }

  private async connect(): Promise<void> {
    const cliPath = this.ctx.resolveBinary(this.config.cliId) ?? this.config.fallbackCommand
    if (!cliPath) {
      throw new Error(`${this.config.label} CLI not configured`)
    }

    // One agent process serves every conversation on the same CLI + workspace —
    // see `connection-registry.ts`. The handshake is shared too, so this session
    // only creates its own `session/new` and attaches its callbacks to it.
    // Those processes go with the runtime (app shutdown), not only with their last lease.
    this.ctx.shared('acp:connections', () => ({ dispose: disposeAllAcpConnections }))
    const lease = await acquireAcpConnection({
      providerId: this.config.providerId,
      command: cliPath,
      args: this.config.agentArgs,
      cwd: this.cwd,
      env: this.env,
      onStderr: (line) => this.logger.debug(`[stderr] ${line}`),
    })
    const connection = lease.connection
    this.connectionLease = lease.release
    const sessionCallbacks = {
        onSessionUpdate: (params: acp.SessionNotification) => {
          // Commands arrive right after `session/new` — before any prompt, so
          // before a mapper exists. Take them at the session level or the very
          // first (and usually only) push is dropped by the guard below.
          if (params.update.sessionUpdate === 'available_commands_update') {
            this.slashCommands = toSlashCommands(this.config, params.update.availableCommands)
            this.logger.debug(
              `${this.config.label} advertised ${this.slashCommands.length} commands ` +
                `(${this.slashCommands.filter((c) => c.type === 'skill').length} skills)`,
            )
            return
          }
          if (params.update.sessionUpdate === 'config_option_update') {
            this.updateConfigOptions(params.update.configOptions)
            return
          }
          if (!this.activeMapper || !this.activeQueue) return
          for (const part of this.activeMapper.handleUpdate(params.update, params._meta ?? undefined)) {
            this.activeQueue.push(part)
          }
        },
        onRequestPermission: (params: acp.RequestPermissionRequest) =>
          this.handlePermissionRequest(params),
        onExit: (error?: Error) => {
          if (error) {
            this.logger.error(`${this.config.label} agent exited: ${describeError(error)}`)
            this.activeQueue?.push({ type: 'error', error })
          }
          this.activeQueue?.close()
        },
    }
    this.connection = connection

    // The handshake carries each model's context window; read it here so a
    // session has it without a second spawn.
    this.contextWindows = this.readContextWindows(lease.initialize)

    const resumed = await this.tryLoadSession(connection, lease.initialize, sessionCallbacks)
    if (!resumed) {
      const newSession = await connection.agent.newSession({ cwd: this.cwd, mcpServers: this.mcpServers })
      this.sessionId = newSession.sessionId
      this.updateConfigOptions(newSession.configOptions)
      this.unregisterSession = connection.registerSession(this.sessionId, sessionCallbacks)
      this.logger.info(`${this.config.label} session created: ${this.sessionId}`)
    }

    // Apply explicit selections after reading the agent's actual defaults. A
    // model change can replace the effort options, so effort always goes last.
    const { model, mode, effort } = this.initialOptions
    if (model && (model !== this.currentModelId || (!this.configOptions && model !== this.config.defaultModelId))) await this.applyModel(model)
    if (mode && (mode !== this.currentModeId || (!this.configOptions && mode !== this.config.defaultModeId))) await this.applyMode(mode)
    if (effort && !await this.applyEffort(effort)) {
      throw new UserFacingRuntimeError(`${this.config.label} did not apply reasoning effort: ${effort}`)
    }
  }

  /**
   * Resume the agent's own session for this conversation, when there is one to
   * resume and the agent can. `false` means "start a fresh session instead".
   *
   * This is what makes history survive a restart. `convertToAcpPrompt` sends
   * only the latest user message — every earlier turn lives in the agent
   * process, not in our prompt — so without `session/load` a restarted app
   * began each chat from zero context while still showing the full transcript.
   *
   * Callbacks are registered *before* the load because the agent replays the
   * whole conversation as `session/update` notifications while it restores.
   * That replay is deliberately discarded: `onSessionUpdate` bails when there
   * is no active mapper, and during connect there isn't one — operon already
   * holds the transcript, so re-emitting it would duplicate every message. The
   * one part worth keeping is `available_commands_update`, handled above that
   * guard, which fills the slash menu without waiting for the first prompt.
   */
  private async tryLoadSession(
    connection: AcpConnection,
    initialize: acp.InitializeResponse,
    callbacks: AcpSessionCallbacks,
  ): Promise<boolean> {
    const sessionId = this.sessionId
    if (!sessionId) return false
    if (initialize.agentCapabilities?.loadSession !== true || !connection.agent.loadSession) {
      this.logger.debug(
        `${this.config.label} does not advertise session/load; starting a new session`,
      )
      return false
    }

    const unregister = connection.registerSession(sessionId, callbacks)
    try {
      const loaded = await connection.agent.loadSession({ sessionId, cwd: this.cwd, mcpServers: this.mcpServers })
      this.updateConfigOptions(loaded?.configOptions)
      this.unregisterSession = unregister
      this.logger.info(`${this.config.label} session resumed: ${sessionId}`)
      return true
    } catch (error) {
      // Expired, pruned, or recorded on another machine — all recoverable by
      // starting over. Clearing the id lets the caller open a fresh session, and
      // the host overwrites the stale record with the new id when the turn ends,
      // so the chat self-heals instead of failing on every message.
      unregister()
      this.sessionId = undefined
      this.logger.warn(
        `${this.config.label} could not resume session ${sessionId} ` +
          `(${describeError(error)}); starting a new one`,
      )
      return false
    }
  }

  /** Model id → advertised context window, for providers that report one. */
  private readContextWindows(initialize: acp.InitializeResponse): Map<string, number> {
    const windows = new Map<string, number>()
    try {
      const { models } = this.config.extractModels(
        { initialize, session: null, commands: null },
        this.currentModelId,
      )
      for (const model of models) {
        if (model.contextWindow != null && model.contextWindow > 0) {
          windows.set(model.id, model.contextWindow)
        }
      }
    } catch (error) {
      // Never fail a session over a display-only number.
      this.logger.warn(`Failed to read ${this.config.label} context windows: ${describeError(error)}`)
    }
    return windows
  }

  private updateConfigOptions(options: acp.SessionConfigOption[] | null | undefined): void {
    if (options == null) return
    this.configOptions = options
    const model = findConfigOption(options, 'model')
    const mode = findConfigOption(options, 'mode')
    if (model) this.currentModelId = model.currentValue
    if (mode) this.currentModeId = mode.currentValue
  }

  private async applyConfig(category: string, value: string): Promise<boolean> {
    const option = findConfigOption(this.configOptions ?? [], category)
    if (!option || !this.connection || !this.sessionId) return false
    if (!configValues(option).some((entry) => entry.value === value)) {
      throw new UserFacingRuntimeError(`Unsupported ${option.name} value: ${value}`)
    }
    if (option.currentValue === value) return true
    const response = await this.connection.agent.setSessionConfigOption({
      sessionId: this.sessionId,
      configId: option.id,
      value,
    })
    this.updateConfigOptions(response.configOptions)
    return findConfigOption(this.configOptions ?? [], category)?.currentValue === value
  }

  private async applyEffort(value: string): Promise<boolean> {
    if (!findConfigOption(this.configOptions ?? [], 'thought_level')) {
      throw new UserFacingRuntimeError(`${this.config.label} does not offer reasoning effort for this model`)
    }
    return this.applyConfig('thought_level', value)
  }

  private async applyModel(value: string): Promise<boolean> {
    if (!this.connection || !this.sessionId) return false
    const model = findConfigOption(this.configOptions ?? [], 'model')
    // Some agents also expose legacy model variants with effort encoded in the
    // id (Antigravity). Keep accepting those through the older endpoint.
    if (model && configValues(model).some((entry) => entry.value === value)) {
      return this.applyConfig('model', value)
    }
    try {
      await this.connection.agent.request('session/set_model', { sessionId: this.sessionId, modelId: value })
      this.currentModelId = value
      return true
    } catch (error) {
      this.logger.warn(`Failed to set ${this.config.label} model ${value}: ${describeError(error)}`)
      return false
    }
  }

  private async applyMode(value: string): Promise<boolean> {
    if (!this.connection || !this.sessionId) return false
    if (findConfigOption(this.configOptions ?? [], 'mode')) return this.applyConfig('mode', value)
    try {
      if (!this.connection.agent.setSessionMode) return false
      await this.connection.agent.setSessionMode({ sessionId: this.sessionId, modeId: value })
      this.currentModeId = value
      return true
    } catch (error) {
      this.logger.warn(`Failed to set ${this.config.label} mode ${value}: ${describeError(error)}`)
      return false
    }
  }

  private async handlePermissionRequest(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const approvalId = randomUUID()
    if (!this.activeMapper || !this.activeQueue) {
      this.logger.warn(`[approval] auto-reject ${approvalId} — no active turn`)
      const optionId = selectPermissionOption(params.options, { type: 'deny' })
      return optionId
        ? { outcome: { outcome: 'selected', optionId } }
        : { outcome: { outcome: 'cancelled' } }
    }

    for (const part of this.activeMapper.handlePermissionRequest(approvalId, params.toolCall)) {
      this.activeQueue.push(part)
    }
    this.logger.info(`[approval] enqueue ${approvalId} (${params.toolCall.title ?? params.toolCall.kind ?? 'tool'})`)

    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      this.pendingDecisions.set(approvalId, { resolve, options: params.options })
    })
  }

  respond(approvalId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingDecisions.get(approvalId)
    if (!pending) return false
    this.pendingDecisions.delete(approvalId)

    const optionId = selectPermissionOption(pending.options, decision)
    this.logger.info(`Resolving approval ${approvalId} with ${decision.type} → optionId=${optionId ?? 'cancelled'}`)
    pending.resolve(
      optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } },
    )
    return true
  }

  abort(): void {
    if (!this.connection || !this.sessionId) return
    if (this.pendingDecisions.size > 0) {
      for (const [, pending] of this.pendingDecisions) {
        pending.resolve({ outcome: { outcome: 'cancelled' } })
      }
      this.pendingDecisions.clear()
    }
    if (!this.activeQueue) return
    this.logger.info(`Abort requested for ${this.config.providerId} session ${this.sessionId}`)
    void this.connection.agent.cancel({ sessionId: this.sessionId }).catch((error) => {
      this.logger.warn(`Failed to cancel ${this.config.label} turn: ${describeError(error)}`)
    })
  }

  async set(patch: SessionPatch): Promise<SessionPatchApplied> {
    await this.ensureConnected()
    const applied: SessionPatchApplied = []
    if (patch.model && await this.applyModel(patch.model)) applied.push('model')
    if (patch.mode && await this.applyMode(patch.mode)) applied.push('mode')
    if (patch.effort && await this.applyEffort(patch.effort)) applied.push('effort')
    return applied
  }

  async close(): Promise<void> {
    for (const pending of this.pendingDecisions.values()) {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
    }
    this.pendingDecisions.clear()
    this.activeQueue?.close()
    // The process is shared, so detach and hand back the lease rather than
    // killing it — it exits once the last conversation lets go.
    this.unregisterSession?.()
    this.unregisterSession = null
    this.connectionLease?.()
    this.connectionLease = null
    this.connection = null
  }
}
