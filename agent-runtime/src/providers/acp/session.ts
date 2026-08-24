import { randomUUID } from 'node:crypto'
import type * as acp from '@zed-industries/agent-client-protocol'
import { getRuntimeHost } from '../../host.js'
import { buildRuntimeEnv } from '../../runtime-env.js'
import { createRuntimeLogger } from '../../logger.js'
import { FILE_REFERENCE_PROMPT, MEMORY_RESOLVER_PROMPT } from '../../memory-resolver-prompt.js'
import type {
  DynamicSetApplied,
  DynamicSetPayload,
  PermissionDecision,
  ProviderDescriptor,
  RuntimeMcpServers,
  RuntimeSession,
  RuntimeSessionParams,
  RuntimeStreamParams,
  RuntimeStreamPart,
  SlashCommandItem,
} from '../../types.js'
import { AsyncQueue } from './async-queue.js'
import { toSlashCommands } from './commands.js'
import { ACP_PROTOCOL_VERSION, AcpConnection } from './connection.js'
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

export class AcpRuntimeSession implements RuntimeSession {
  private readonly logger
  private readonly cwd: string
  private readonly env: Record<string, string>
  private readonly mcpServers: acp.McpServer[]
  private currentModelId: string
  private currentModeId: string
  /** Session instructions (persona) from the host — prepended to the first prompt. */
  private readonly instructions: string | undefined

  private connection: AcpConnection | null = null
  private sessionId: string | undefined
  private initPromise: Promise<void> | null = null
  private activeQueue: AsyncQueue<RuntimeStreamPart> | null = null
  private activeMapper: AcpEventMapper | null = null
  private didPrependResolver = false
  private readonly pendingDecisions = new Map<string, PendingDecision>()
  /** Advertised context window per model id, read off the initialize handshake. */
  private contextWindows = new Map<string, number>()
  /** Latest `available_commands_update`, surfaced through getDescriptorPatch. */
  private slashCommands: SlashCommandItem[] = []

  constructor(
    params: RuntimeSessionParams,
    private readonly config: AcpProviderConfig,
  ) {
    this.logger = createRuntimeLogger(`${config.providerId}-runtime`)
    this.cwd = params.cwd
    this.env = buildRuntimeEnv(params.env)
    this.mcpServers = toAcpMcpServers(params.mcpServers)
    this.currentModelId = params.modelId ?? config.defaultModelId
    this.currentModeId = params.modeId ?? config.defaultModeId
    this.instructions = params.instructions?.trim() || undefined
  }

  getSessionId(): string | undefined {
    return this.sessionId
  }

  getDescriptorPatch(): Partial<
    Pick<ProviderDescriptor, 'currentModelId' | 'currentModeId' | 'slashCommands'>
  > {
    return {
      currentModelId: this.currentModelId,
      currentModeId: this.activeMapper?.getCurrentModeId() ?? this.currentModeId,
      // Only override the descriptor's static list once the agent has actually
      // told us its commands; an empty patch would blank the menu.
      ...(this.slashCommands.length > 0 ? { slashCommands: this.slashCommands } : {}),
    }
  }

  async *stream(params: RuntimeStreamParams): AsyncIterable<RuntimeStreamPart> {
    if (this.activeQueue) {
      throw new Error(`A ${this.config.label} turn is already in progress`)
    }

    await this.ensureConnected()

    const conversion = convertToAcpPrompt(params.messages)
    if (conversion.warnings.length > 0) {
      for (const warning of conversion.warnings) this.logger.warn(`[message-mapper] ${warning.message}`)
    }
    // ACP has no system-prompt channel, so session instructions ride as a
    // preamble on the first prompt — that puts them in the agent's own history,
    // so they survive its session persistence without re-sending.
    if (!this.didPrependResolver) {
      const preamble = [MEMORY_RESOLVER_PROMPT, FILE_REFERENCE_PROMPT, this.instructions]
        .filter((s): s is string => !!s && s.trim().length > 0)
        .join('\n\n')
      conversion.prompt = prependTextToPrompt(conversion.prompt, preamble)
      this.didPrependResolver = true
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
    params.signal?.addEventListener('abort', handleAbort, { once: true })

    const promptPromise = this.runPrompt(conversion.prompt, mapper, queue).finally(() => {
      params.signal?.removeEventListener('abort', handleAbort)
      if (this.activeQueue === queue) this.activeQueue = null
      if (this.activeMapper === mapper) this.activeMapper = null
      queue.close()
    })

    try {
      for await (const part of queue) yield part
      await promptPromise
    } finally {
      params.signal?.removeEventListener('abort', handleAbort)
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
      for (const part of mapper.finalize(result.stopReason, result._meta)) queue.push(part)
    } catch (error) {
      this.logger.error(`Prompt failed for ${this.config.providerId} session ${this.sessionId}: ${describeError(error)}`)
      queue.push({ type: 'error', error: normalizeAcpError(error) })
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.connection && this.sessionId) return
    if (!this.initPromise) this.initPromise = this.connect()
    await this.initPromise
  }

  private async connect(): Promise<void> {
    const cliPath = getRuntimeHost().resolveCliPath(this.config.cliId) ?? this.config.fallbackCommand
    if (!cliPath) {
      throw new Error(`${this.config.label} CLI not configured`)
    }

    const connection = new AcpConnection({
      providerId: this.config.providerId,
      command: cliPath,
      args: this.config.agentArgs,
      cwd: this.cwd,
      env: this.env,
      callbacks: {
        onSessionUpdate: (params) => {
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
          if (!this.activeMapper || !this.activeQueue) return
          for (const part of this.activeMapper.handleUpdate(params.update, params._meta)) {
            this.activeQueue.push(part)
          }
        },
        onRequestPermission: (params) => this.handlePermissionRequest(params),
        onStderr: (line) => this.logger.debug(`[stderr] ${line}`),
        onExit: (error) => {
          if (error) {
            this.logger.error(`${this.config.label} agent exited: ${describeError(error)}`)
            this.activeQueue?.push({ type: 'error', error })
          }
          this.activeQueue?.close()
        },
      },
    })
    this.connection = connection

    this.logger.info(`Starting ${this.config.providerId} ACP agent: ${cliPath} ${this.config.agentArgs.join(' ')}`)
    const initialize = await connection.agent.initialize({
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    // The same handshake the descriptor probe uses also carries each model's
    // context window; read it here so a session has it without a second spawn.
    this.contextWindows = this.readContextWindows(initialize)

    const newSession = await connection.agent.newSession({ cwd: this.cwd, mcpServers: this.mcpServers })
    this.sessionId = newSession.sessionId
    this.logger.info(`${this.config.label} session created: ${this.sessionId}`)

    // A fresh session already starts on the agent's default model + mode, and
    // re-setting the current selection makes some agents (Grok) reject it. Only
    // push a selection that differs from the provider default.
    if (this.currentModelId !== this.config.defaultModelId) await this.applyModel()
    if (this.currentModeId !== this.config.defaultModeId) await this.applyMode()
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

  private async applyModel(): Promise<void> {
    if (!this.connection || !this.sessionId) return
    try {
      await this.connection.agent.setSessionModel?.({ sessionId: this.sessionId, modelId: this.currentModelId })
    } catch (error) {
      this.logger.warn(`Failed to set ${this.config.label} model ${this.currentModelId}: ${describeError(error)}`)
    }
  }

  private async applyMode(): Promise<void> {
    if (!this.connection || !this.sessionId) return
    try {
      await this.connection.agent.setSessionMode?.({ sessionId: this.sessionId, modeId: this.currentModeId })
    } catch (error) {
      this.logger.warn(`Failed to set ${this.config.label} mode ${this.currentModeId}: ${describeError(error)}`)
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

  resolvePermission(approvalId: string, decision: PermissionDecision): boolean {
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

  /** ACP's session/set_model and session/set_mode only cover these two. */
  async dynamicSet(payload: DynamicSetPayload): Promise<DynamicSetApplied> {
    const applied: DynamicSetApplied = []
    if (payload.modelId && payload.modelId !== this.currentModelId) {
      this.currentModelId = payload.modelId
      await this.applyModel()
      applied.push('modelId')
    }
    if (payload.modeId && payload.modeId !== this.currentModeId) {
      this.currentModeId = payload.modeId
      await this.applyMode()
      applied.push('modeId')
    }
    return applied
  }

  async dispose(): Promise<void> {
    for (const pending of this.pendingDecisions.values()) {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
    }
    this.pendingDecisions.clear()
    this.activeQueue?.close()
    if (this.connection) {
      await this.connection.dispose()
      this.connection = null
    }
  }
}
