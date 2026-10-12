import type {
  Options,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  Query,
  McpServerStatus,
  SDKMessage,
  SDKRateLimitEvent,
  SDKSystemMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
  SDKUserMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk'
import { deleteSession, query } from '@anthropic-ai/claude-agent-sdk'
import type {
  DetailedContextUsage,
  DynamicSetApplied,
  DynamicSetPayload,
  PermissionDecision,
  RuntimeBackgroundEvent,
  RuntimeBackgroundTask,
  RuntimeSession,
  RuntimeSessionParams,
  RuntimeStreamParams,
  SessionDisposeReason,
  SlashCommandItem,
} from '../../types.js'
import { RuntimeInjectionUnavailableError } from '../../types.js'
import { readStreamAsAsyncIterable } from '../../utils/read-stream.js'
import { buildClaudeRuntimeSettings } from './config.js'
import type { RuntimeContext } from '../../context.js'
import { convertToClaudeMessages } from './message-mapper.js'
import { ClaudeTextStreamBuilder } from './text-stream-builder.js'
import { applyClaudeUsagePush, peekClaudeAccountUsage } from './usage-probe.js'
import type { ClaudeRuntimeSettings, PendingApproval } from './types.js'
import { createRuntimeLogger } from '../../logger.js'
import { logProviderRaw } from '../../provider-raw-log.js'
import { SIDE_CHAT_BOUNDARY_PROMPT } from '../../side-chat-prompt.js'

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
  /** Started by the agent itself (see `openBackgroundTurn`), not by a `stream()` call. */
  background?: { finished: Promise<void> }
}

type SDKTaskMessage =
  | SDKTaskStartedMessage
  | SDKTaskProgressMessage
  | SDKTaskUpdatedMessage
  | SDKTaskNotificationMessage

const TASK_SUBTYPES = new Set(['task_started', 'task_progress', 'task_updated', 'task_notification'])

function isTaskMessage(message: SDKMessage): message is SDKTaskMessage {
  return message.type === 'system' && TASK_SUBTYPES.has(message.subtype)
}

/** Finished tasks kept for the UI; the oldest are dropped past this. */
const MAX_SETTLED_TASKS = 50

// ---------------------------------------------------------------------------
// buildQueryOptions
// ---------------------------------------------------------------------------

function buildQueryOptions(
  settings: ClaudeRuntimeSettings,
  abortController: AbortController,
  canUseTool: Options['canUseTool'],
  forkSession = false,
): Options {
  return {
    model: settings.modelId,
    abortController,
    cwd: settings.cwd,
    resume: settings.resume,
    // With `resume`, branches the conversation into a new session id instead of
    // continuing the resumed one — the parent is left untouched. Only ever set
    // on a side chat's first turn; see `ensureWarmQuery`.
    forkSession,
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
    // A running sub-agent's card shows what it is doing; the summary is a cheap
    // fork on the sub-agent's own prompt cache, roughly every 30s.
    agentProgressSummaries: true,
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

  // Between-turn output (background sub-agents, replies the agent starts itself)
  private backgroundListener: ((event: RuntimeBackgroundEvent) => void) | null = null
  private readonly backgroundTasks = new Map<string, RuntimeBackgroundTask>()
  private cachedInitData: Record<string, unknown> | null = null

  // Side chat state. `boundaryPending` is true only until the branch's first
  // user message carries the boundary marker — see `stream()`.
  private boundaryPending: boolean

  constructor(params: RuntimeSessionParams, private readonly ctx: RuntimeContext) {
    this.settings = buildClaudeRuntimeSettings(params, ctx)
    this.currentModelId = this.settings.modelId
    this.currentModeId = this.settings.permissionMode
    this.currentThinkingLevel = this.settings.thinkingLevel
    this.sessionId = this.settings.resume
    // A side chat that already has a session id forked on an earlier turn; only
    // a branch that has not run yet still owes its boundary marker.
    this.boundaryPending = this.settings.forkFrom != null && !this.settings.resume
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

    // A side chat branches off its parent exactly once: while it has no session
    // id of its own, resume the parent *and* fork. The CLI reports the branch's
    // new id on the init message, and from the next warm query on this resumes
    // that id like any other conversation — so a dropped CLI process reconnects
    // to the branch rather than forking the parent a second time.
    const forkingNow = !this.sessionId && this.settings.forkFrom != null
    const resume = forkingNow ? this.settings.forkFrom!.sessionId : this.sessionId

    const queryOptions = buildQueryOptions(
      {
        ...this.settings,
        modelId: this.currentModelId,
        permissionMode: this.currentModeId as PermissionMode,
        thinkingLevel: this.currentThinkingLevel as ClaudeRuntimeSettings['thinkingLevel'],
        resume,
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
      forkingNow,
    )

    this.logger.info(
      `SDK query options entrypoint env=${queryOptions.env?.CLAUDE_CODE_ENTRYPOINT ?? '<unset>'}, resume=${resume ?? '<new>'}${forkingNow ? ' (fork)' : ''}`,
    )

    const response = query({
      prompt: this.inputQueue,
      options: queryOptions,
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

        // Quota moved. The event carries a full `unifiedWindows` snapshot (not
        // just the window `rateLimitType` names), so it both updates the shared
        // account snapshot the polling endpoint serves and goes straight to the
        // client — a push lands the moment usage steps 1%, where the poll is a
        // periodic sweep. Polling stays for what a push cannot see: spend by
        // other clients, and windows resetting while this app sends nothing.
        if (message.type === 'rate_limit_event') {
          this.handleRateLimitEvent(message)
          continue
        }

        if (isTaskMessage(message)) {
          this.handleTaskMessage(message)
          continue
        }

        // A sub-agent's step belongs to the card of the Agent call that spawned
        // it. A background agent outlives the turn that launched it, so its steps
        // arrive between turns or inside a later turn whose message has no such
        // card — feeding them to that turn would hang them off nothing. The card
        // reads those from the sub-agent's transcript instead.
        if (
          (message.type === 'assistant' || message.type === 'user' || message.type === 'stream_event') &&
          message.parent_tool_use_id &&
          !this.turn?.builder.hasTool(message.parent_tool_use_id)
        ) {
          continue
        }

        // The agent is replying without having been asked: Claude Code answers a
        // background agent that just finished. Open a turn for it so the reply is
        // not lost.
        if (
          !this.turn &&
          this.backgroundListener &&
          (message.type === 'assistant' || message.type === 'stream_event')
        ) {
          this.openBackgroundTurn()
        }

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

  onBackground(listener: (event: RuntimeBackgroundEvent) => void): void {
    this.backgroundListener = listener
  }

  /**
   * Keep the background-agent list current and report it whole.
   *
   * Only sub-agents are tracked (`local_agent`): they are what renders as a card.
   * Background shells and housekeeping tasks have their own surfaces, or none.
   * Foreground agents are skipped too — their steps stream inside the turn.
   */
  private handleTaskMessage(message: SDKTaskMessage): void {
    const now = Date.now()
    const existing = this.backgroundTasks.get(message.task_id)
    let next: RuntimeBackgroundTask | undefined

    switch (message.subtype) {
      case 'task_started': {
        if (message.task_type !== 'local_agent' || message.skip_transcript || !message.tool_use_id) return
        if (!message.is_backgrounded) return
        next = {
          taskId: message.task_id,
          toolUseId: message.tool_use_id,
          description: message.description,
          status: 'running',
          startedAt: now,
        }
        break
      }
      case 'task_updated': {
        if (!existing) return
        if (message.patch.description) next = { ...existing, description: message.patch.description }
        break
      }
      case 'task_progress': {
        if (!existing) return
        next = {
          ...existing,
          toolUses: message.usage.tool_uses,
          lastToolName: message.last_tool_name ?? existing.lastToolName,
          summary: message.summary ?? existing.summary,
        }
        break
      }
      case 'task_notification': {
        if (!existing) return
        next = {
          ...existing,
          status: message.status,
          summary: message.summary || existing.summary,
          toolUses: message.usage?.tool_uses ?? existing.toolUses,
          endedAt: now,
        }
        break
      }
    }
    if (!next) return

    this.backgroundTasks.set(next.taskId, next)
    const settled = [...this.backgroundTasks.values()].filter((task) => task.status !== 'running')
    for (const task of settled.slice(0, Math.max(0, settled.length - MAX_SETTLED_TASKS))) {
      this.backgroundTasks.delete(task.taskId)
    }
    this.backgroundListener?.({ type: 'tasks', tasks: [...this.backgroundTasks.values()] })
  }

  /**
   * Give a reply the agent started on its own a turn of its own, handed to the
   * background listener as a stream. It closes on the reply's `result` like any
   * other turn; `stream()` waits for that before starting the user's.
   */
  private openBackgroundTurn(): void {
    const listener = this.backgroundListener
    if (!listener) return
    let turnDone!: () => void
    const finished = new Promise<void>((resolve) => {
      turnDone = resolve
    })
    const partsStream = new ReadableStream<import('../../types.js').RuntimeStreamPart>({
      start: (controller) => {
        const builder = new ClaudeTextStreamBuilder({
          controller,
          modelId: this.currentModelId,
          requestBody: { prompt: '' },
          warnings: [],
          getSessionId: () => this.sessionId,
        })
        builder.emitStart()
        this.turn = { builder, controller, done: turnDone, background: { finished } }
      },
    })
    this.logger.info('Agent started a turn on its own; routing it to the background listener')
    listener({ type: 'turn', parts: readStreamAsAsyncIterable(partsStream) })
  }

  /**
   * Record pushed quota and, when a turn is streaming, hand it to the client.
   *
   * The snapshot update is unconditional because quota is account-scoped — it
   * is worth keeping even when this event arrives between turns and there is no
   * stream to put it on.
   */
  private handleRateLimitEvent(message: SDKRateLimitEvent): void {
    if (!applyClaudeUsagePush(this.ctx, message.rate_limit_info)) return
    const usage = peekClaudeAccountUsage(this.ctx)
    if (usage) this.turn?.builder.emitRateLimits(usage)
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

    // The agent may be mid-way through a reply it started itself. The CLI answers
    // one input at a time anyway, so let that reply finish on its own stream
    // rather than having its tail land in this one.
    const backgroundTurn = this.turn?.background
    if (backgroundTurn) await backgroundTurn.finished

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
          const body: SDKUserMessage['message']['content'] =
            converted.streamingContentParts.length > 0
              ? converted.streamingContentParts
              : [{ type: 'text', text: converted.messagesPrompt }]

          // A side chat's first message opens with the boundary marker: the fork
          // carries the parent's whole transcript, and without this the model
          // reads it as its own unfinished task. Claude Code has no API for
          // appending a standalone item to a session's history, so it rides at
          // the head of the first user message — which puts it in the same place
          // relative to the inherited history, after the cached prefix the fork
          // shares with its parent.
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

  async dispose(reason: SessionDisposeReason = 'discard'): Promise<void> {
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
    // A 'rebuild' is the same conversation getting a fresh warm query (fast mode
    // toggled, MCP map changed), so the fork has to outlive it — the new query
    // resumes it by id.
    if (reason === 'discard') await this.discardEphemeralFork()
  }

  /**
   * Delete the branch a side chat forked for itself.
   *
   * Codex's forks are ephemeral by construction — they never touch disk — but
   * Claude Code's are ordinary session files, so an abandoned side chat would
   * leave one in the projects dir and in the `/resume` picker forever. Disposal
   * is where a side chat ends (the chat row goes with it), so this is the last
   * chance to clean up.
   *
   * The id compared against is the parent's, so this can only ever delete a
   * branch this session forked, never the conversation it came from.
   */
  private async discardEphemeralFork(): Promise<void> {
    const source = this.settings.forkFrom
    if (!source || source.ephemeral === false) return
    const forkedId = this.sessionId
    if (!forkedId || forkedId === source.sessionId) return
    this.sessionId = undefined
    try {
      await deleteSession(forkedId, { dir: this.settings.cwd })
      this.logger.info(`Deleted side chat fork ${forkedId}`)
    } catch (error) {
      this.logger.warn(`Failed to delete side chat fork ${forkedId}: ${String(error)}`)
    }
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
      throw new RuntimeInjectionUnavailableError('No active Claude Code session to inject into')
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
