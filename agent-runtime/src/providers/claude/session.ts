import type {
  Options,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  Query,
  McpServerStatus,
  SDKMessage,
  SDKSystemMessage,
  SDKUserMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type {
  DetailedContextUsage,
  DynamicSetApplied,
  DynamicSetPayload,
  PermissionDecision,
  RuntimeSession,
  RuntimeSessionParams,
  RuntimeStreamParams,
  SlashCommandItem,
} from '../../types.js'
import { readStreamAsAsyncIterable } from '../../utils/read-stream.js'
import { buildClaudeRuntimeSettings } from './config.js'
import { convertToClaudeMessages } from './message-mapper.js'
import { ClaudeTextStreamBuilder } from './text-stream-builder.js'
import type { ClaudeRuntimeSettings, PendingApproval } from './types.js'
import { createRuntimeLogger } from '../../logger.js'
import { logProviderRaw } from '../../provider-raw-log.js'

const MCP_READY_TIMEOUT_MS = 15_000
const MCP_STATUS_POLL_INTERVAL_MS = 200

function isAbortError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const candidate = error as { name?: unknown; code?: unknown }
    if (candidate.name === 'AbortError') return true
    if (typeof candidate.code === 'string' && candidate.code.toUpperCase() === 'ABORT_ERR') return true
  }
  return false
}

// ---------------------------------------------------------------------------
// PersistentInputQueue — stays open across turns, like Desktop's AsyncMessageQueue
// ---------------------------------------------------------------------------

class PersistentInputQueue implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = []
  private resolver: ((msg: SDKUserMessage | null) => void) | null = null
  private closed = false

  enqueue(msg: SDKUserMessage): void {
    if (this.closed) return
    if (this.resolver) {
      const r = this.resolver
      this.resolver = null
      r(msg)
    } else {
      this.queue.push(msg)
    }
  }

  close(): void {
    this.closed = true
    if (this.resolver) {
      const r = this.resolver
      this.resolver = null
      r(null)
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (!this.closed) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!
      } else {
        const msg = await new Promise<SDKUserMessage | null>((resolve) => {
          this.resolver = resolve
        })
        if (msg === null) break
        yield msg
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Per-turn state — created for each stream() call, replaced on next turn
// ---------------------------------------------------------------------------

interface TurnState {
  builder: ClaudeTextStreamBuilder
  controller: ReadableStreamDefaultController<import('../../types.js').RuntimeStreamPart>
  done: () => void
}

// ---------------------------------------------------------------------------
// buildQueryOptions
// ---------------------------------------------------------------------------

function buildQueryOptions(
  settings: ClaudeRuntimeSettings,
  abortController: AbortController,
  canUseTool: Options['canUseTool'],
): Options {
  return {
    model: settings.modelId,
    abortController,
    cwd: settings.cwd,
    resume: settings.resume,
    permissionMode: settings.permissionMode,
    effort: settings.thinkingLevel,
    // Fast mode lives in the settings (flag) layer, not as a top-level option.
    // Only inject when enabled so we don't clobber the user's settings.json value.
    settings: settings.fastMode ? { fastMode: true } : undefined,
    pathToClaudeCodeExecutable: settings.pathToClaudeCodeExecutable,
    settingSources: settings.settingSources,
    includePartialMessages: settings.includePartialMessages,
    persistSession: settings.persistSession,
    enableFileCheckpointing: settings.enableFileCheckpointing,
    allowDangerouslySkipPermissions: settings.allowDangerouslySkipPermissions,
    allowedTools: settings.allowedTools,
    disallowedTools: settings.disallowedTools,
    mcpServers: settings.mcpServers,
    env: settings.env,
    systemPrompt: settings.systemPrompt,
    extraArgs: settings.extraArgs,
    canUseTool,
  }
}

// ---------------------------------------------------------------------------
// ClaudeRuntimeSession — warm-session model (single query across turns)
// ---------------------------------------------------------------------------

export class ClaudeRuntimeSession implements RuntimeSession {
  private readonly logger = createRuntimeLogger('claude-runtime')
  private readonly settings: ClaudeRuntimeSettings
  private currentModelId: string
  private currentModeId: string
  private currentThinkingLevel: string
  private sessionId: string | undefined

  // Warm session state — lives across all turns
  private activeQuery: Query | null = null
  private inputQueue: PersistentInputQueue | null = null
  private abortController: AbortController | null = null
  private messageLoopPromise: Promise<void> | null = null
  private messageLoopDead = false
  private mcpReadyPromise: Promise<void> | null = null

  // Per-turn state — swapped on each stream() call
  private turn: TurnState | null = null

  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private cachedInitData: Record<string, unknown> | null = null

  constructor(params: RuntimeSessionParams) {
    this.settings = buildClaudeRuntimeSettings(params)
    this.currentModelId = this.settings.modelId
    this.currentModeId = this.settings.permissionMode
    this.currentThinkingLevel = this.settings.thinkingLevel
    this.sessionId = this.settings.resume
    this.logger.info(
      `Runtime settings entrypoint env=${this.settings.env?.CLAUDE_CODE_ENTRYPOINT ?? '<unset>'}, process env=${process.env.CLAUDE_CODE_ENTRYPOINT ?? '<unset>'}, cwd=${this.settings.cwd}`,
    )
  }

  // -----------------------------------------------------------------------
  // Warm query lifecycle
  // -----------------------------------------------------------------------

  private ensureWarmQuery(): void {
    if (this.activeQuery && !this.messageLoopDead) return

    this.inputQueue = new PersistentInputQueue()
    this.abortController = new AbortController()

    const queryOptions = buildQueryOptions(
      {
        ...this.settings,
        modelId: this.currentModelId,
        permissionMode: this.currentModeId as PermissionMode,
        thinkingLevel: this.currentThinkingLevel as ClaudeRuntimeSettings['thinkingLevel'],
        resume: this.sessionId,
      },
      this.abortController,
      async (toolName, input, context) =>
        new Promise<PermissionResult>((resolve) => {
          const toolCallId = context.toolUseID
          this.pendingApprovals.set(toolCallId, {
            toolCallId,
            toolName,
            input,
            suggestions: context.suggestions as PermissionUpdate[] | undefined,
            resolve,
          })
          this.turn?.builder.queueApprovalRequest(toolCallId, toolName, input, context.agentID ?? null)
        }),
    )

    this.logger.info(
      `SDK query options entrypoint env=${queryOptions.env?.CLAUDE_CODE_ENTRYPOINT ?? '<unset>'}, resume=${this.sessionId ?? '<new>'}`,
    )

    const response = query({
      prompt: this.inputQueue,
      options: queryOptions,
    })
    this.activeQuery = response
    this.messageLoopDead = false
    this.logger.info(`Warm query created${this.sessionId ? ` (resume ${this.sessionId})` : ''}`)

    this.messageLoopPromise = this.runMessageLoop()
    this.mcpReadyPromise = this.waitForMcpReady(response)
  }

  private async waitForMcpReady(
    activeQuery: Query,
    timeoutMs = MCP_READY_TIMEOUT_MS,
  ): Promise<void> {
    let cancelled = false
    let lastStatuses: McpServerStatus[] = []
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined

    const readinessProbe = async (): Promise<void> => {
      await activeQuery.initializationResult()

      while (!cancelled) {
        const statuses = await activeQuery.mcpServerStatus()
        if (cancelled) return

        lastStatuses = statuses
        const pendingServers = statuses.filter((server) => server.status === 'pending')
        if (pendingServers.length === 0) {
          const summary =
            statuses.length > 0
              ? statuses.map((server) => `${server.name}=${server.status}`).join(', ')
              : 'none configured'
          this.logger.info(`MCP ready: ${summary}`)
          return
        }

        await new Promise<void>((resolve) => {
          setTimeout(resolve, MCP_STATUS_POLL_INTERVAL_MS)
        })
      }
    }

    const timeout = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs)
    })

    try {
      const outcome = await Promise.race([
        readinessProbe().then(() => 'ready' as const),
        timeout,
      ])
      if (outcome === 'timeout') {
        cancelled = true
        const pendingNames = lastStatuses
          .filter((server) => server.status === 'pending')
          .map((server) => server.name)
        const detail = pendingNames.length > 0 ? ` (${pendingNames.join(', ')})` : ''
        this.logger.warn(`MCP still pending after ${timeoutMs}ms${detail}; proceeding`)
      }
    } catch (error) {
      cancelled = true
      this.logger.warn(
        `MCP readiness probe failed: ${error instanceof Error ? error.message : String(error)}; proceeding`,
      )
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }

  // -----------------------------------------------------------------------
  // Background message loop — reads from query, routes to current turn
  // -----------------------------------------------------------------------

  private async runMessageLoop(): Promise<void> {
    try {
      for await (const message of this.activeQuery as AsyncIterable<SDKMessage>) {
        logProviderRaw('claude', message)

        // Ignore partial push notifications. The account-level polling endpoint
        // fetches the complete quota window snapshot out of band.
        if (message.type === 'rate_limit_event') continue

        const turn = this.turn
        if (!turn) {
          // Messages arriving without an active turn (e.g. system:init before
          // user message is enqueued). Handle system messages directly.
          if (message.type === 'system') {
            this.handleSystemInit(message as SDKSystemMessage)
          }
          continue
        }

        if (message.type === 'stream_event') {
          turn.builder.handleStreamEvent(message, false)
          continue
        }

        if (message.type === 'assistant') {
          turn.builder.handleAssistantMessage(message, false)
          continue
        }

        if (message.type === 'user') {
          turn.builder.handleUserMessage(message)
          continue
        }

        if (message.type === 'system') {
          this.handleSystemInit(message as SDKSystemMessage, turn.builder)
          continue
        }

        if (message.type === 'result') {
          this.sessionId = message.session_id
          this.logger.info(`Turn result received (session ${this.sessionId})`)

          turn.builder.handleResult(message, false)
          turn.controller.close()
          turn.done()
          this.turn = null
          // Don't break — keep the loop alive for the next turn
          continue
        }
      }
    } catch (error) {
      if (!isAbortError(error)) {
        this.logger.error(`Message loop failed: ${error instanceof Error ? error.message : String(error)}`)
        this.turn?.builder.emitError(error)
        this.turn?.controller.close()
        this.turn?.done()
        this.turn = null
      } else {
        this.logger.info('Message loop aborted')
        // On abort during active turn, close the stream cleanly
        if (this.turn) {
          this.turn.controller.close()
          this.turn.done()
          this.turn = null
        }
      }
    } finally {
      this.messageLoopDead = true
    }
  }

  private handleSystemInit(message: SDKSystemMessage, builder?: ClaudeTextStreamBuilder): void {
    // Use the provided builder (if in a turn) or handle session-level data directly
    if (builder) {
      const systemInfo = builder.handleSystemMessage(message)
      if (systemInfo?.sessionId) {
        this.sessionId = systemInfo.sessionId
        this.logger.info(`Session ID updated to ${systemInfo.sessionId}`)
      }
      if (systemInfo?.initData) this.cachedInitData = systemInfo.initData
    } else {
      // Minimal handling outside a turn — just capture session ID and init data
      if (message.subtype === 'init') {
        if (message.session_id) {
          this.sessionId = message.session_id
          this.logger.info(`Session ID updated to ${message.session_id} (pre-turn)`)
        }
        this.cachedInitData = {
          session_id: message.session_id,
          slash_commands: message.slash_commands ?? [],
          skills: message.skills ?? [],
          tools: message.tools ?? [],
          mcp_servers: message.mcp_servers ?? [],
          model: message.model,
          agents: message.agents,
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // stream() — enqueues a user message and returns the output for one turn
  // -----------------------------------------------------------------------

  async *stream(params: RuntimeStreamParams) {
    this.logger.info(`Starting stream with model ${this.currentModelId} in mode ${this.currentModeId}`)

    const converted = convertToClaudeMessages(params.messages)
    const warnings = (converted.warnings ?? []).map((message) => ({ type: 'other' as const, message }))

    // Promise that resolves when this turn's result is received
    let turnDone!: () => void
    const turnFinished = new Promise<void>((resolve) => {
      turnDone = resolve
    })

    const partsStream = new ReadableStream({
      start: (controller) => {
        const builder = new ClaudeTextStreamBuilder({
          controller,
          modelId: this.currentModelId,
          requestBody: { prompt: converted.messagesPrompt },
          warnings,
          getSessionId: () => this.sessionId,
        })
        builder.emitStart()

        // Install per-turn state so the message loop routes output here
        this.turn = { builder, controller, done: turnDone }

        // Connect external abort signal
        if (params.signal) {
          params.signal.addEventListener(
            'abort',
            () => void this.activeQuery?.interrupt().catch(() => {}),
            { once: true },
          )
        }

        // Ensure the warm query is alive
        this.ensureWarmQuery()

        const activeQuery = this.activeQuery
        const inputQueue = this.inputQueue

        void (async () => {
          await this.mcpReadyPromise

          if (
            !activeQuery ||
            !inputQueue ||
            this.activeQuery !== activeQuery ||
            this.inputQueue !== inputQueue ||
            this.messageLoopDead
          ) {
            if (this.turn?.builder === builder) {
              controller.close()
              turnDone()
              this.turn = null
            }
            return
          }

          // Build the user message only after the query's MCP list is stable.
          const content: SDKUserMessage['message']['content'] =
            converted.streamingContentParts.length > 0
              ? converted.streamingContentParts
              : [{ type: 'text', text: converted.messagesPrompt }]

          inputQueue.enqueue({
            type: 'user',
            message: { role: 'user', content },
            parent_tool_use_id: null,
            session_id: this.sessionId ?? '',
          })
        })().catch((error: unknown) => {
          builder.emitError(error)
          controller.close()
          turnDone()
          if (this.turn?.builder === builder) this.turn = null
        })
      },
    })

    // Yield parts from the ReadableStream. The stream closes when the
    // message loop receives a result for this turn.
    yield* readStreamAsAsyncIterable(partsStream)

    // Wait for cleanup to complete (guards against stream reader finishing
    // before the controller.close() call propagates)
    await turnFinished
  }

  // -----------------------------------------------------------------------
  // abort — interrupts the current turn but keeps the warm session alive
  // -----------------------------------------------------------------------

  abort(): void {
    this.logger.info('Abort requested (interrupt)')
    // Interrupt stops the current generation; cli.js stays alive
    void this.activeQuery?.interrupt().catch(() => {})
  }

  // -----------------------------------------------------------------------
  // dispose — tears down the entire warm session
  // -----------------------------------------------------------------------

  async dispose(): Promise<void> {
    this.logger.info('Disposing warm session')
    this.inputQueue?.close()
    this.inputQueue = null
    this.abortController?.abort()
    this.abortController = null
    void this.activeQuery?.interrupt().catch(() => {})
    this.activeQuery = null
    this.pendingApprovals.clear()
    if (this.turn) {
      this.turn.controller.close()
      this.turn.done()
      this.turn = null
    }
    await this.messageLoopPromise?.catch(() => {})
    this.messageLoopPromise = null
    this.mcpReadyPromise = null
  }

  // -----------------------------------------------------------------------
  // Permission handling
  // -----------------------------------------------------------------------

  resolvePermission(approvalId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingApprovals.get(approvalId)
    if (!pending) return false
    this.pendingApprovals.delete(approvalId)

    switch (decision.type) {
      case 'allow':
        pending.resolve({
          behavior: 'allow',
          updatedInput: decision.updatedInput ?? pending.input,
          toolUseID: pending.toolCallId,
        })
        return true
      case 'deny':
        pending.resolve({
          behavior: 'deny',
          message: decision.reason ?? 'Permission denied by user',
          toolUseID: pending.toolCallId,
        })
        return true
      case 'allow-always':
        pending.resolve({
          behavior: 'allow',
          updatedInput: decision.updatedInput ?? pending.input,
          toolUseID: pending.toolCallId,
          updatedPermissions: pending.suggestions ?? [],
        })
        return true
    }
  }

  // -----------------------------------------------------------------------
  // Inject — enqueue a follow-up message into the current turn
  // -----------------------------------------------------------------------

  async injectMessage(content: string): Promise<void> {
    const activeQuery = this.activeQuery
    const inputQueue = this.inputQueue
    await this.mcpReadyPromise

    if (
      !activeQuery ||
      !inputQueue ||
      this.activeQuery !== activeQuery ||
      this.inputQueue !== inputQueue ||
      this.messageLoopDead
    ) {
      throw new Error('No active Claude Code session to inject into')
    }
    this.logger.info('Injecting follow-up into warm session')
    inputQueue.enqueue({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: content }] },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? '',
    })
  }

  async agentControl(method: string, params: unknown): Promise<unknown> {
    const activeQuery = this.activeQuery
    if (!activeQuery || this.messageLoopDead) {
      throw new Error('No active Claude Code session')
    }

    switch (method) {
      case 'mcp.list': {
        const servers = await activeQuery.mcpServerStatus()
        return {
          servers: servers.map((server) => {
            const config = server.config
            const transport =
              config && 'type' in config && typeof config.type === 'string'
                ? config.type
                : config && 'command' in config
                  ? 'stdio'
                  : undefined

            return {
              name: server.name,
              status: server.status,
              ...(transport ? { transport } : {}),
              ...(server.error ? { error: server.error } : {}),
              ...(server.tools ? { toolCount: server.tools.length } : {}),
            }
          }),
        }
      }
      case 'mcp.reconnect': {
        const mutation = activeQuery.reconnectMcpServer(readControlString(params, 'name'))
        this.gateMessagesOnMcpMutation(activeQuery, mutation, true)
        await mutation
        return { ok: true }
      }
      case 'mcp.toggle': {
        const enabled = readControlBoolean(params, 'enabled')
        const mutation = activeQuery.toggleMcpServer(
          readControlString(params, 'name'),
          enabled,
        )
        this.gateMessagesOnMcpMutation(activeQuery, mutation, enabled)
        await mutation
        return { ok: true }
      }
      default:
        throw new Error(`Unsupported Claude session control method: ${method}`)
    }
  }

  private gateMessagesOnMcpMutation(
    activeQuery: Query,
    mutation: Promise<void>,
    waitForConnection: boolean,
  ): void {
    this.mcpReadyPromise = mutation
      .then(() => waitForConnection ? this.waitForMcpReady(activeQuery) : undefined)
      .catch((error: unknown) => {
        this.logger.warn(
          `MCP control failed before readiness check: ${error instanceof Error ? error.message : String(error)}; proceeding`,
        )
      })
  }

  // -----------------------------------------------------------------------
  // Session info
  // -----------------------------------------------------------------------

  getSessionId(): string | undefined {
    return this.sessionId
  }

  /**
   * The SDK response is projected field-by-field rather than returned as-is.
   *
   * `SDKControlGetContextUsageResponse` assigns to `DetailedContextUsage` unchanged,
   * so returning it type-checks — but the extra fields survive into the JSON the
   * route serialises. `gridRows` alone (a per-square 2-D array the panel never
   * renders) was ~50KB of every response on a poll the client runs every few
   * seconds during a turn, all of it crossing the tunnel to the browser.
   */
  async getContextUsage(): Promise<DetailedContextUsage | null> {
    if (!this.activeQuery) return null
    try {
      const usage = await this.activeQuery.getContextUsage()
      if (!usage) return null
      return {
        categories: usage.categories,
        totalTokens: usage.totalTokens,
        maxTokens: usage.maxTokens,
        rawMaxTokens: usage.rawMaxTokens,
        percentage: usage.percentage,
        model: usage.model,
        memoryFiles: usage.memoryFiles,
        isAutoCompactEnabled: usage.isAutoCompactEnabled,
        autoCompactThreshold: usage.autoCompactThreshold,
        apiUsage: usage.apiUsage,
      }
    } catch (error) {
      this.logger.error(`getContextUsage failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /**
   * `thinkingLevel` is deliberately absent: `effort` is baked into the query options
   * at `ensureWarmQuery`, and the SDK exposes no setter for it (only setModel /
   * setPermissionMode / setMaxThinkingTokens, the last being a different knob). It
   * would take tearing the warm query down — i.e. restarting the CLI subprocess —
   * so we report it as not applied and let the caller rebuild the session instead.
   */
  async dynamicSet(payload: DynamicSetPayload): Promise<DynamicSetApplied> {
    const applied: DynamicSetApplied = []
    if (payload.modelId) {
      this.logger.info(`Switching model to ${payload.modelId}`)
      this.currentModelId = payload.modelId
      await this.activeQuery?.setModel(payload.modelId)
      applied.push('modelId')
    }
    if (payload.modeId) {
      this.logger.info(`Switching permission mode to ${payload.modeId}`)
      this.currentModeId = payload.modeId
      await this.activeQuery?.setPermissionMode(payload.modeId as PermissionMode)
      applied.push('modeId')
    }
    return applied
  }

  private getSupportedCommands(): SlashCommand[] | undefined {
    const slashCommands = this.cachedInitData?.slash_commands
    return Array.isArray(slashCommands)
      ? slashCommands.filter((command): command is SlashCommand => typeof command === 'object' && command !== null)
      : undefined
  }

  getDescriptorPatch(): {
    currentModelId: string
    currentModeId: string
    currentThinkingLevel: string
    slashCommands?: SlashCommandItem[]
  } {
    const skills = Array.isArray(this.cachedInitData?.skills)
      ? this.cachedInitData.skills.filter((skill): skill is string => typeof skill === 'string' && skill.length > 0)
      : []
    const commands = this.getSupportedCommands() ?? []
    const seen = new Set<string>()
    const slashCommands: SlashCommandItem[] = []

    for (const name of skills) {
      if (seen.has(name)) continue
      seen.add(name)
      slashCommands.push({ name, description: '', type: 'skill' })
    }

    for (const command of commands) {
      const name = typeof command.name === 'string' ? command.name : ''
      if (!name || seen.has(name)) continue
      seen.add(name)
      slashCommands.push({
        name,
        description: typeof command.description === 'string' ? command.description : '',
        type: 'command',
      })
    }

    return {
      currentModelId: this.currentModelId,
      currentModeId: this.currentModeId,
      currentThinkingLevel: this.currentThinkingLevel,
      ...(slashCommands.length > 0 ? { slashCommands } : {}),
    }
  }
}

function readControlString(params: unknown, key: string): string {
  const value = params && typeof params === 'object'
    ? (params as Record<string, unknown>)[key]
    : undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Session control requires string param '${key}'`)
  }
  return value
}

function readControlBoolean(params: unknown, key: string): boolean {
  const value = params && typeof params === 'object'
    ? (params as Record<string, unknown>)[key]
    : undefined
  if (typeof value !== 'boolean') {
    throw new Error(`Session control requires boolean param '${key}'`)
  }
  return value
}
