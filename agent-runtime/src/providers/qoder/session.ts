import {
  deleteSession,
  ProcessTransport,
  qodercliAuth,
  query,
  type McpServerStatus,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@qoder-ai/qoder-agent-sdk'
import { randomUUID } from 'node:crypto'
import type { ModelMessage } from 'ai'
import type {
  AgentInput,
  AgentSession,
  DetailedContextUsage,
  McpServerInfo,
  McpStatusControl,
  PermissionDecision,
  RuntimeBackgroundEvent,
  RuntimeStreamPart,
  SendOptions,
  SessionCloseReason,
  SessionOptions,
  SessionPatch,
  SessionPatchApplied,
  SlashCommandItem,
} from '../../types.js'
import { RuntimeInjectionUnavailableError, type InjectOptions } from '../../types.js'
import type { RuntimeContext } from '../../context.js'
import { toUserMessages } from '../../utils/agent-input.js'
import { readStreamAsAsyncIterable } from '../../utils/read-stream.js'
import { PersistentInputQueue } from '../../utils/persistent-input-queue.js'
import { createRuntimeLogger } from '../../logger.js'
import { logProviderRaw } from '../../provider-raw-log.js'
import { SIDE_CHAT_BOUNDARY_PROMPT } from '../../side-chat-prompt.js'
// Qoder's wire format is Claude Code's (same message, stream-event and result
// shapes), so the Claude stream builder and prompt mapper are reused as-is.
import { ClaudeTextStreamBuilder } from '../claude/text-stream-builder.js'
import { convertToClaudeMessages } from '../claude/message-mapper.js'
import { buildQoderRuntimeSettings, resolveQoderEffort, resolveQoderMode } from './config.js'
import { asClaudeAssistant, asClaudeResult, asClaudeStreamEvent, asClaudeUser, asQoderContent } from './claude-wire.js'
import { defaultQoderModelId, findQoderModel, peekQoderInitInfo } from './init-info.js'
import { McpCallStreamUnwrapper, parseMcpCall, unwrapAssistantMcpCalls, wrapMcpCall } from './mcp-call.js'
import type { QoderEffort, QoderMode, QoderPendingApproval, QoderRuntimeSettings } from './types.js'

type ClaudeUserContent = ReturnType<typeof convertToClaudeMessages>['streamingContentParts']

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

interface TurnState {
  builder: ClaudeTextStreamBuilder
  controller: ReadableStreamDefaultController<RuntimeStreamPart>
  done: () => void
  /** Started by the agent itself (see `openBackgroundTurn`), not by a `send()` call. */
  background?: { finished: Promise<void> }
}

/** Qoder reports context use as percentages; operon's panel counts tokens. */
const CONTEXT_CATEGORY_NAMES: Record<string, string> = {
  system_prompt: 'System prompt',
  system_tools: 'System tools',
  skills: 'Skills',
  messages: 'Messages',
  other: 'Other',
  free_space: 'Free space',
  auto_compact: 'Autocompact buffer',
}

/** What only Qoder sessions offer. */
export interface QoderSessionNative {
  /** Status only: the SDK keeps reconnect / toggle internal. */
  mcp: McpStatusControl
}

export class QoderRuntimeSession implements AgentSession<QoderSessionNative> {
  private readonly logger = createRuntimeLogger('qoder-runtime')
  private readonly settings: QoderRuntimeSettings
  private currentModelId: string
  private currentMode: QoderMode
  private currentEffort: QoderEffort
  private sessionId: string | undefined

  // Warm session state — lives across all turns
  private activeQuery: Query | null = null
  private inputQueue: PersistentInputQueue<SDKUserMessage> | null = null
  private abortController: AbortController | null = null
  private messageLoopPromise: Promise<void> | null = null
  private messageLoopDead = false
  private mcpReadyPromise: Promise<void> | null = null
  /**
   * Effort only exists as a launch flag (`--reasoning-effort`); there is no
   * control request for it. A change takes effect by restarting the warm query
   * before the next turn, resuming the same session.
   */
  private restartBeforeNextTurn = false

  private turn: TurnState | null = null
  private readonly mcpCalls = new McpCallStreamUnwrapper()
  /** Injected messages the CLI has not taken in yet, by the uuid they were sent with. */
  private pendingInjections = new Map<string, { id: string; text: string }>()
  private readonly pendingApprovals = new Map<string, QoderPendingApproval>()
  private backgroundListener: ((event: RuntimeBackgroundEvent) => void) | null = null
  private initCommands: { skills: string[]; slashCommands: string[] } | null = null

  /** True only until a side chat's first user message carries the boundary marker. */
  private boundaryPending: boolean

  constructor(params: SessionOptions, private readonly ctx: RuntimeContext) {
    this.settings = buildQoderRuntimeSettings(params, ctx)
    // No choice means the account's default; name it, so the session reports the
    // same model the descriptor shows instead of an empty id.
    this.currentModelId = this.settings.modelId || defaultQoderModelId(peekQoderInitInfo(ctx)) || ''
    this.currentMode = this.settings.mode
    this.currentEffort = this.settings.effort
    this.sessionId = this.settings.resume
    this.boundaryPending = this.settings.forkFrom != null && !this.settings.resume
  }

  // -----------------------------------------------------------------------
  // Warm query lifecycle
  // -----------------------------------------------------------------------

  /**
   * `--reasoning-effort` for the current model, or nothing when the model does
   * not list the chosen level — the CLI then runs the model's own default
   * rather than a level it was never tuned for.
   */
  private effortArgs(): Record<string, string | null> | undefined {
    const efforts = findQoderModel(this.ctx, this.currentModelId)?.efforts
    if (efforts && !efforts.includes(this.currentEffort)) return undefined
    return { 'reasoning-effort': this.currentEffort }
  }

  private buildQueryOptions(abortController: AbortController, resume: string | undefined, forkSession: boolean): Options {
    const planMode = this.currentMode === 'plan'
    return {
      auth: qodercliAuth(),
      // Spawn the user's own qodercli rather than the Worker runtime the SDK
      // downloads at install time (skipped for operon; see electron-builder.yml).
      transport: ProcessTransport.default,
      pathToQoderCLIExecutable: this.settings.pathToQoderCLIExecutable,
      model: this.currentModelId || undefined,
      abortController,
      cwd: this.settings.cwd,
      additionalDirectories: this.settings.additionalDirectories,
      resume,
      forkSession,
      permissionMode: planMode ? 'default' : this.currentMode,
      planMode,
      settingSources: ['user', 'project', 'local'],
      includePartialMessages: true,
      persistSession: true,
      // Never `allowDangerouslySkipPermissions`: unlike the Claude SDK option of
      // the same name (which only makes bypass *reachable*), the Qoder SDK turns
      // it into `--dangerously-skip-permissions` and every tool runs unasked, in
      // every mode. Bypass is a plain `permissionMode` here.
      allowedTools: this.settings.allowedTools,
      mcpServers: this.settings.mcpServers,
      // MCP tools behind mcp_list / mcp_get / mcp_call instead of one schema
      // each — see mcp-call.ts for why this is not optional.
      settings: { mcp: { lazyLoad: true } },
      env: this.settings.env,
      systemPrompt: this.settings.systemPrompt,
      extraArgs: { 'replay-user-messages': null, ...this.effortArgs() },
      canUseTool: async (toolName, input, context) =>
        new Promise<PermissionResult>((resolve) => {
          const toolCallId = context.toolUseID
          // The approval card shows the MCP tool `mcp_call` stands for; an
          // edited input goes back wrapped the way qodercli expects it.
          const call = parseMcpCall(toolName, input)
          this.pendingApprovals.set(toolCallId, {
            toolCallId,
            toolName,
            input,
            suggestions: context.suggestions,
            ...(call ? { wrapInput: (args: Record<string, unknown>) => ({ ...wrapMcpCall(call.toolName, args) }) } : {}),
            resolve,
          })
          this.turn?.builder.queueApprovalRequest(
            toolCallId,
            call?.toolName ?? toolName,
            call?.arguments ?? input,
            context.agentID ?? null,
          )
        }),
    }
  }

  private ensureWarmQuery(): void {
    if (this.activeQuery && !this.messageLoopDead) return

    this.inputQueue = new PersistentInputQueue<SDKUserMessage>()
    this.pendingInjections.clear()
    this.abortController = new AbortController()

    // A side chat forks its parent exactly once — while it has no session id of
    // its own. After that it resumes its own branch like any conversation.
    const forkingNow = !this.sessionId && this.settings.forkFrom != null
    const resume = forkingNow ? this.settings.forkFrom!.from : this.sessionId

    const response = query({
      prompt: this.inputQueue,
      options: this.buildQueryOptions(this.abortController, resume, forkingNow),
    })
    this.activeQuery = response
    this.messageLoopDead = false
    this.logger.info(
      forkingNow
        ? `Warm query created (forking ${resume} for a side chat)`
        : `Warm query created${resume ? ` (resume ${resume})` : ''}`,
    )

    this.messageLoopPromise = this.runMessageLoop()
    this.mcpReadyPromise = this.waitForMcpReady(response)
  }

  /** Tear down the warm query between turns; the next turn resumes the session. */
  private async stopWarmQuery(): Promise<void> {
    this.inputQueue?.close()
    this.inputQueue = null
    this.abortController?.abort()
    this.abortController = null
    const activeQuery = this.activeQuery
    this.activeQuery = null
    await activeQuery?.close().catch(() => {})
    await this.messageLoopPromise?.catch(() => {})
    this.messageLoopPromise = null
    this.mcpReadyPromise = null
  }

  private async waitForMcpReady(activeQuery: Query, timeoutMs = MCP_READY_TIMEOUT_MS): Promise<void> {
    let cancelled = false
    let lastStatuses: McpServerStatus[] = []
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined

    const readinessProbe = async (): Promise<void> => {
      await activeQuery.initializationResult()
      while (!cancelled) {
        const statuses = await activeQuery.mcpServerStatus()
        if (cancelled) return
        lastStatuses = statuses
        if (!statuses.some((server) => server.status === 'pending')) {
          const summary =
            statuses.length > 0 ? statuses.map((server) => `${server.name}=${server.status}`).join(', ') : 'none configured'
          this.logger.info(`MCP ready: ${summary}`)
          return
        }
        await new Promise<void>((resolve) => setTimeout(resolve, MCP_STATUS_POLL_INTERVAL_MS))
      }
    }

    const timeout = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs)
    })

    try {
      const outcome = await Promise.race([readinessProbe().then(() => 'ready' as const), timeout])
      if (outcome === 'timeout') {
        cancelled = true
        const pending = lastStatuses.filter((server) => server.status === 'pending').map((server) => server.name)
        this.logger.warn(`MCP still pending after ${timeoutMs}ms${pending.length ? ` (${pending.join(', ')})` : ''}; proceeding`)
      }
    } catch (error) {
      cancelled = true
      this.logger.warn(`MCP readiness probe failed: ${error instanceof Error ? error.message : String(error)}; proceeding`)
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }

  // -----------------------------------------------------------------------
  // Message loop — reads from the warm query, routes to the current turn
  // -----------------------------------------------------------------------

  private async runMessageLoop(): Promise<void> {
    const activeQuery = this.activeQuery
    if (!activeQuery) return
    try {
      for await (const message of activeQuery) {
        logProviderRaw('qoder', message)

        // A sub-agent's step belongs to the card of the Agent call that spawned
        // it; with no such card in this turn (a background agent finishing
        // later) there is nothing to hang it on.
        if (
          (message.type === 'assistant' || message.type === 'user' || message.type === 'stream_event') &&
          message.parent_tool_use_id &&
          !this.turn?.builder.hasTool(message.parent_tool_use_id)
        ) {
          continue
        }

        // The agent replying unasked, or an injected message taken in after the
        // turn it was meant for ended: give it a turn of its own.
        if (
          !this.turn &&
          this.backgroundListener &&
          (message.type === 'assistant' || message.type === 'stream_event' || this.pendingInjectionOf(message))
        ) {
          this.openBackgroundTurn()
        }

        if (message.type === 'system') {
          this.handleSystemMessage(message)
          continue
        }

        const turn = this.turn
        if (!turn) continue

        switch (message.type) {
          case 'stream_event':
            for (const event of this.mcpCalls.transform(message)) {
              turn.builder.handleStreamEvent(asClaudeStreamEvent(event), false)
            }
            break
          case 'assistant':
            turn.builder.handleAssistantMessage(asClaudeAssistant(unwrapAssistantMcpCalls(message)), false)
            break
          case 'user': {
            const injected = this.pendingInjectionOf(message)
            if (injected) {
              this.pendingInjections.delete(injected.uuid)
              turn.builder.handleInjectedInput(injected.id, injected.text)
            } else {
              turn.builder.handleUserMessage(asClaudeUser(message))
            }
            break
          }
          case 'result':
            this.sessionId = message.session_id
            this.logger.info(`Turn result received (session ${this.sessionId})`)
            turn.builder.handleResult(asClaudeResult(message), false)
            turn.controller.close()
            turn.done()
            this.turn = null
            break
        }
      }
    } catch (error) {
      if (!isAbortError(error)) {
        this.logger.error(`Message loop failed: ${error instanceof Error ? error.message : String(error)}`)
        this.turn?.builder.emitError(error)
      } else {
        this.logger.info('Message loop aborted')
      }
      if (this.turn) {
        this.turn.controller.close()
        this.turn.done()
        this.turn = null
      }
    } finally {
      // A loop torn down by `stopWarmQuery` has already been replaced (or the
      // session is closing); only the live query's loop marks the session dead.
      if (this.activeQuery === activeQuery) this.messageLoopDead = true
    }
  }

  private handleSystemMessage(message: Extract<SDKMessage, { type: 'system' }>): void {
    switch (message.subtype) {
      case 'init':
        if (message.session_id) this.sessionId = message.session_id
        this.initCommands = { skills: message.skills ?? [], slashCommands: message.slash_commands ?? [] }
        break
      // The agent can leave Plan Mode on its own (its plan was accepted); the
      // permission mode underneath is the `default` that `plan` runs on.
      case 'plan_mode_changed':
        if (message.plan_mode.active) this.currentMode = 'plan'
        else if (this.currentMode === 'plan') this.currentMode = 'default'
        break
    }
  }

  /** The `inject` call this message is the CLI's echo of, if any. */
  private pendingInjectionOf(message: SDKMessage): { uuid: string; id: string; text: string } | undefined {
    if (message.type !== 'user' || !('isReplay' in message) || !message.isReplay || !message.uuid) return undefined
    const pending = this.pendingInjections.get(message.uuid)
    return pending ? { uuid: message.uuid, ...pending } : undefined
  }

  onBackground(listener: (event: RuntimeBackgroundEvent) => void): () => void {
    this.backgroundListener = listener
    return () => {
      if (this.backgroundListener === listener) this.backgroundListener = null
    }
  }

  private newBuilder(controller: ReadableStreamDefaultController<RuntimeStreamPart>, prompt: string, warnings: { type: 'other'; message: string }[]) {
    return new ClaudeTextStreamBuilder({
      controller,
      modelId: this.currentModelId,
      requestBody: { prompt },
      warnings,
      getSessionId: () => this.sessionId,
    })
  }

  private openBackgroundTurn(): void {
    const listener = this.backgroundListener
    if (!listener) return
    let turnDone!: () => void
    const finished = new Promise<void>((resolve) => {
      turnDone = resolve
    })
    const partsStream = new ReadableStream<RuntimeStreamPart>({
      start: (controller) => {
        const builder = this.newBuilder(controller, '', [])
        builder.emitStart()
        this.turn = { builder, controller, done: turnDone, background: { finished } }
      },
    })
    this.logger.info('Agent started a turn on its own; routing it to the background listener')
    listener({ type: 'turn', parts: readStreamAsAsyncIterable(partsStream) })
  }

  // -----------------------------------------------------------------------
  // send() — enqueues a user message and returns the output for one turn
  // -----------------------------------------------------------------------

  send(input: AgentInput, options?: SendOptions): AsyncIterable<RuntimeStreamPart> {
    return this.runTurn(toUserMessages(input), options?.signal)
  }

  private async *runTurn(messages: ModelMessage[], signal: AbortSignal | undefined) {
    this.logger.info(`Starting stream with model ${this.currentModelId || '<default>'} in mode ${this.currentMode}`)

    const backgroundTurn = this.turn?.background
    if (backgroundTurn) await backgroundTurn.finished

    if (this.restartBeforeNextTurn) {
      this.restartBeforeNextTurn = false
      this.logger.info('Restarting warm query to apply a launch-time setting')
      await this.stopWarmQuery()
    }

    const converted = convertToClaudeMessages(messages)
    const warnings = (converted.warnings ?? []).map((message) => ({ type: 'other' as const, message }))

    let turnDone!: () => void
    const turnFinished = new Promise<void>((resolve) => {
      turnDone = resolve
    })

    const partsStream = new ReadableStream<RuntimeStreamPart>({
      start: (controller) => {
        const builder = this.newBuilder(controller, converted.messagesPrompt, warnings)
        builder.emitStart()
        this.turn = { builder, controller, done: turnDone }

        signal?.addEventListener('abort', () => void this.activeQuery?.interrupt().catch(() => {}), { once: true })

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

          const body: ClaudeUserContent =
            converted.streamingContentParts.length > 0
              ? converted.streamingContentParts
              : [{ type: 'text', text: converted.messagesPrompt }]

          // A side chat's first message opens with the boundary marker, so the
          // model does not read the inherited transcript as its own open task.
          let content = body
          if (this.boundaryPending) {
            this.boundaryPending = false
            content =
              typeof body === 'string'
                ? `${SIDE_CHAT_BOUNDARY_PROMPT}\n\n${body}`
                : [{ type: 'text', text: SIDE_CHAT_BOUNDARY_PROMPT }, ...body]
          }

          inputQueue.enqueue({
            type: 'user',
            message: { role: 'user', content: asQoderContent(content) },
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

    yield* readStreamAsAsyncIterable(partsStream)
    await turnFinished
  }

  abort(): void {
    this.logger.info('Abort requested (interrupt)')
    void this.activeQuery?.interrupt().catch(() => {})
  }

  async close(reason: SessionCloseReason = 'discard'): Promise<void> {
    this.logger.info('Disposing warm session')
    this.pendingApprovals.clear()
    if (this.turn) {
      this.turn.controller.close()
      this.turn.done()
      this.turn = null
    }
    await this.stopWarmQuery()
    if (reason === 'discard') await this.discardEphemeralFork()
  }

  /**
   * Delete the branch a side chat forked for itself. Qoder's forks are ordinary
   * session files, so an abandoned side chat would otherwise stay in the
   * session list forever. Only ever deletes a branch, never the parent.
   */
  private async discardEphemeralFork(): Promise<void> {
    const source = this.settings.forkFrom
    if (!source || source.ephemeral === false) return
    const forkedId = this.sessionId
    if (!forkedId || forkedId === source.from) return
    this.sessionId = undefined
    try {
      await deleteSession(forkedId, { dir: this.settings.cwd })
      this.logger.info(`Deleted side chat fork ${forkedId}`)
    } catch (error) {
      this.logger.warn(`Failed to delete side chat fork ${forkedId}: ${String(error)}`)
    }
  }

  // -----------------------------------------------------------------------
  // Permissions and injection
  // -----------------------------------------------------------------------

  respond(approvalId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingApprovals.get(approvalId)
    if (!pending) return false
    this.pendingApprovals.delete(approvalId)
    // The card was shown the unwrapped MCP call, so an edited input comes back unwrapped.
    const updatedInput =
      decision.type !== 'deny' && decision.updatedInput
        ? (pending.wrapInput?.(decision.updatedInput) ?? decision.updatedInput)
        : pending.input

    switch (decision.type) {
      case 'allow':
        pending.resolve({ behavior: 'allow', updatedInput, toolUseID: pending.toolCallId })
        return true
      case 'deny':
        pending.resolve({ behavior: 'deny', message: decision.reason ?? 'Permission denied by user', toolUseID: pending.toolCallId })
        return true
      case 'allow-always':
        pending.resolve({
          behavior: 'allow',
          updatedInput,
          toolUseID: pending.toolCallId,
          updatedPermissions: pending.suggestions ?? [],
        })
        return true
    }
  }

  async inject(content: string, options?: InjectOptions): Promise<void> {
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
      throw new RuntimeInjectionUnavailableError('No active Qoder session to inject into')
    }
    const uuid = randomUUID()
    if (options?.id) this.pendingInjections.set(uuid, { id: options.id, text: content })
    inputQueue.enqueue({
      type: 'user',
      uuid,
      // Taken in at the next safe point (a tool result), never cutting off the
      // reply being written ('now' would).
      priority: 'next',
      message: { role: 'user', content: [{ type: 'text', text: content }] },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? '',
    })
  }

  readonly native: QoderSessionNative = {
    mcp: { list: () => this.listMcpServers() },
  }

  private async listMcpServers(): Promise<McpServerInfo[]> {
    const activeQuery = this.activeQuery
    if (!activeQuery || this.messageLoopDead) throw new Error('No active Qoder session')
    const servers = await activeQuery.mcpServerStatus()
    return servers.map((server) => {
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
    })
  }

  // -----------------------------------------------------------------------
  // Session info
  // -----------------------------------------------------------------------

  get id(): string | undefined {
    return this.sessionId
  }

  /**
   * Qoder reports only percentages, so tokens are derived from the model's
   * context window. Without a known window there is nothing honest to show.
   */
  async contextUsage(): Promise<DetailedContextUsage | null> {
    if (!this.activeQuery || this.messageLoopDead) return null
    const window = findQoderModel(this.ctx, this.currentModelId)?.defaultContextWindow
    if (!window) return null
    try {
      const usage = await this.activeQuery.getContextUsage()
      // Until the first request is built the CLI has measured nothing: no
      // `system_tools` row and a near-zero total, which would show as a
      // confident "0.1%" for the first seconds of every turn.
      if (!usage.categories.some((category) => category.type === 'system_tools' && category.percentage > 0)) return null
      const tokensOf = (percentage: number) => Math.round((percentage / 100) * window)
      const percentage = usage.contextWindow.usedPercentage
      return {
        categories: usage.categories.map((category) => ({
          name: CONTEXT_CATEGORY_NAMES[category.type] ?? category.type,
          tokens: tokensOf(category.percentage),
          color: category.type,
          kind: category.type === 'free_space' ? 'free' : category.type === 'auto_compact' ? 'buffer' : 'used',
        })),
        totalTokens: tokensOf(percentage),
        maxTokens: window,
        rawMaxTokens: window,
        percentage,
        model: usage.model,
        memoryFiles: [],
        isAutoCompactEnabled: usage.autoCompact.enabled,
        autoCompactThreshold: usage.autoCompact.thresholdPercentage,
        apiUsage: null,
      }
    } catch (error) {
      this.logger.error(`getContextUsage failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  async set(patch: SessionPatch): Promise<SessionPatchApplied> {
    const applied: SessionPatchApplied = []
    const activeQuery = this.messageLoopDead ? null : this.activeQuery
    if (patch.model) {
      this.logger.info(`Switching model to ${patch.model}`)
      await activeQuery?.setModel(patch.model)
      this.currentModelId = patch.model
      applied.push('model')
    }
    if (patch.mode) {
      const next = resolveQoderMode(patch.mode)
      this.logger.info(`Switching mode to ${next}`)
      if (activeQuery) {
        // Plan Mode is its own switch; leaving it restores the permission mode.
        if (next === 'plan') {
          await activeQuery.setPlanMode?.(true)
        } else {
          if (this.currentMode === 'plan') await activeQuery.setPlanMode?.(false)
          await activeQuery.setPermissionMode(next)
        }
      }
      this.currentMode = next
      applied.push('mode')
    }
    if (patch.effort) {
      const next = resolveQoderEffort(patch.effort)
      if (next !== this.currentEffort) {
        this.currentEffort = next
        if (activeQuery) this.restartBeforeNextTurn = true
      }
      applied.push('effort')
    }
    return applied
  }

  state(): {
    currentModelId: string
    currentModeId: string
    currentThinkingLevel: string
    slashCommands?: SlashCommandItem[]
  } {
    const seen = new Set<string>()
    const slashCommands: SlashCommandItem[] = []
    for (const name of this.initCommands?.skills ?? []) {
      if (!name || seen.has(name)) continue
      seen.add(name)
      slashCommands.push({ name, description: '', type: 'skill' })
    }
    for (const name of this.initCommands?.slashCommands ?? []) {
      if (!name || seen.has(name)) continue
      seen.add(name)
      slashCommands.push({ name, description: '', type: 'command' })
    }
    return {
      currentModelId: this.currentModelId,
      currentModeId: this.currentMode,
      currentThinkingLevel: this.currentEffort,
      ...(slashCommands.length > 0 ? { slashCommands } : {}),
    }
  }
}
