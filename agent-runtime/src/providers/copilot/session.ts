import { randomUUID } from 'node:crypto'
import {
  CopilotClient,
  RuntimeConnection,
  type MCPServerConfig,
  type CopilotSession,
  type ExitPlanModeHandler,
  type PermissionHandler,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionConfigBase,
  type SessionEventHandler,
} from '@github/copilot-sdk'
import type {
  DynamicSetApplied,
  DynamicSetPayload,
  PermissionDecision,
  RuntimeMcpServers,
  RuntimeSession,
  RuntimeSessionParams,
  RuntimeStreamParams,
  RuntimeStreamPart,
  SlashCommandItem,
} from '../../types.js'
import { createRuntimeLogger } from '../../logger.js'
import { logProviderRaw } from '../../provider-raw-log.js'
import { readStreamAsAsyncIterable } from '../../utils/read-stream.js'
import {
  COPILOT_DEFAULT_MODE,
  COPILOT_DEFAULT_MODEL,
  type CopilotReasoningEffort,
  buildPrompt,
  copilotAgentMode,
  copilotModeAsksApproval,
  copilotRuntimeEnv,
  resolveCopilotCliPath,
  resolveReasoningEffort,
} from './config.js'
import { CopilotMessageMapper } from './message-mapper.js'
import type { CopilotSessionEvent } from './types.js'
import {
  captureCopilotSlashCommands,
  createCopilotSlashCommandState,
  getCopilotSlashCommands,
} from './slash-commands.js'

const logger = createRuntimeLogger('copilot')

/** Adapt the host's transport-neutral MCP map to the Copilot SDK shape. */
export function toCopilotMcpServers(
  servers?: RuntimeMcpServers,
): Record<string, MCPServerConfig> | undefined {
  if (!servers || Object.keys(servers).length === 0) return undefined
  const result: Record<string, MCPServerConfig> = {}
  for (const [name, entry] of Object.entries(servers)) {
    if ('command' in entry) {
      result[name] = {
        type: 'stdio',
        command: entry.command,
        args: entry.args,
        env: entry.env,
      }
    } else {
      result[name] = {
        type: entry.type,
        url: entry.url,
        headers: entry.headers,
      }
    }
  }
  return result
}

/**
 * Render a Copilot PermissionRequest as a tool-call for the Normal-mode approval
 * card: a tool name plus the salient detail of the pending action.
 */
function describePermissionRequest(
  request: PermissionRequest,
): { toolName: string; input: Record<string, unknown> } {
  switch (request.kind) {
    case 'shell':
      return { toolName: 'shell', input: { command: request.fullCommandText, intention: request.intention } }
    case 'write':
      return { toolName: 'write', input: { file: request.fileName, diff: request.diff, intention: request.intention } }
    case 'read':
      return { toolName: 'read', input: { file: request.path } }
    case 'mcp':
      return { toolName: request.toolName, input: { server: request.serverName, tool: request.toolName } }
    case 'url':
      return { toolName: 'fetch', input: { url: request.url, intention: request.intention } }
    case 'memory':
      return { toolName: 'memory', input: { fact: request.fact } }
    case 'custom-tool':
      return { toolName: request.toolName, input: {} }
    default:
      return { toolName: (request as { kind: string }).kind, input: {} }
  }
}

/** ask_user handler shape (the SDK doesn't re-export its type from the entrypoint). */
type UserInputHandler = NonNullable<SessionConfigBase['onUserInputRequest']>
type UserInputResult = Awaited<ReturnType<UserInputHandler>>

/**
 * One Copilot chat thread, backed by a long-lived `CopilotClient` (which spawns
 * the `copilot` runtime over stdio) and a single `CopilotSession`. Unlike the
 * cursor provider — which spawns a fresh process per turn — the Copilot SDK
 * keeps the session alive and pushes events, so continuity across turns is
 * automatic; resume across restarts is via `resumeSession(sessionId)`.
 *
 * Each `stream()` turn registers an event handler, sends the prompt, and bridges
 * the SDK's push-style events into the pull-style RuntimeStreamPart iterable via
 * a ReadableStream, completing when `session.idle` fires.
 */
export class CopilotRuntimeSession implements RuntimeSession {
  private readonly cwd: string
  private readonly env?: Record<string, string | undefined>
  private readonly isWorker: boolean
  private readonly mcpServers: Record<string, MCPServerConfig> | undefined
  private modelId: string
  private modeId: string
  private readonly thinkingLevel?: string
  /** Effort levels the selected model accepts (from the provider's cached list). */
  private readonly supportedEffortLevels: string[]
  private sessionId?: string
  /** Session instructions (persona) from the host — appended to the SDK system message. */
  private readonly instructions: string | undefined

  private client: CopilotClient | null = null
  private session: CopilotSession | null = null
  private starting: Promise<CopilotSession> | null = null

  // --- interactive bridging (ask_user / exit_plan_mode) ---------------------
  // The SDK invokes onUserInputRequest / onExitPlanModeRequest while a turn is
  // in flight. They surface an approval card on the active turn's stream and
  // block until the UI answers via resolvePermission(). Keyed by approvalId.
  private readonly pendingApprovals = new Map<string, (decision: PermissionDecision) => void>()
  private activeEmit: ((part: RuntimeStreamPart) => void) | null = null
  private activeMapper: CopilotMessageMapper | null = null

  // Slash commands discovered from the live session (skills + SDK commands).
  private readonly slashCommandState = createCopilotSlashCommandState()

  constructor(params: RuntimeSessionParams, supportedEffortLevels: string[] = []) {
    this.cwd = params.cwd
    this.env = params.env
    this.isWorker = params.isWorker ?? false
    this.mcpServers = toCopilotMcpServers(params.mcpServers)
    this.modelId = params.modelId ?? COPILOT_DEFAULT_MODEL
    this.modeId = params.modeId ?? COPILOT_DEFAULT_MODE
    this.thinkingLevel = params.thinkingLevel
    this.supportedEffortLevels = supportedEffortLevels
    this.sessionId = params.sessionId
    this.instructions = params.instructions?.trim() || undefined
  }

  /**
   * The `reasoningEffort` to send for this session, or undefined to omit it.
   * Only set when the picked level is one the selected model actually accepts —
   * the SDK throws if you pass effort to a model that doesn't support it.
   */
  private resolveEffort(): CopilotReasoningEffort | undefined {
    const effort = resolveReasoningEffort(this.thinkingLevel)
    return effort && this.supportedEffortLevels.includes(effort) ? effort : undefined
  }

  // Copilot decides tool permission per call via this handler. Reads `this.modeId`
  // live so dynamicSet() takes effect on the next tool call. Autopilot/Plan
  // approve automatically; Normal (interactive) surfaces an approval card and
  // waits for the user's decision.
  private readonly handlePermission: PermissionHandler = async (
    request: PermissionRequest,
  ): Promise<PermissionRequestResult> => {
    if (!copilotModeAsksApproval(this.modeId)) return { kind: 'approve-for-session' }
    return this.requestToolPermission(request)
  }

  /**
   * Normal mode: surface the pending action as an approval card on the active
   * turn and block until the UI answers via resolvePermission(). The runtime
   * fires onPermissionRequest BEFORE executing, so we emit the tool-call card
   * ourselves (and gate the mapper's duplicate start); on approval the runtime's
   * own execution_complete renders the real result on the same card. With no
   * active turn to surface UI (worker session), approve to avoid hanging.
   */
  private async requestToolPermission(request: PermissionRequest): Promise<PermissionRequestResult> {
    const emit = this.activeEmit
    if (!emit) return { kind: 'approve-for-session' }

    const { toolName, input } = describePermissionRequest(request)
    const toolCallId = request.toolCallId ?? randomUUID()
    const approvalId = randomUUID()

    // Close any open assistant text/reasoning so the card renders cleanly.
    for (const part of this.activeMapper?.flushOpenBlocks() ?? []) emit(part)

    // Emit the tool-call FIRST (the UI reads input from the prior tool-call),
    // then the approval request. Gate the mapper so the runtime's duplicate
    // execution_start is dropped while its completion still renders the result.
    this.activeMapper?.gateApprovedTool(toolCallId, toolName, JSON.stringify(input))
    const toolCall = { type: 'tool-call' as const, toolCallId, toolName, input, providerExecuted: true, dynamic: true }
    emit({ type: 'tool-input-start', id: toolCallId, toolName, providerExecuted: true, dynamic: true } as RuntimeStreamPart)
    emit(toolCall as unknown as RuntimeStreamPart)
    emit({ type: 'tool-approval-request', approvalId, toolCall } as unknown as RuntimeStreamPart)

    const decision = await new Promise<PermissionDecision>((resolve) => {
      this.pendingApprovals.set(approvalId, resolve)
    })

    if (decision.type === 'deny') {
      // No runtime completion will arrive — close the card as rejected and pass
      // the reason back to the agent.
      this.activeMapper?.ungateTool(toolCallId)
      emit({
        type: 'tool-result',
        toolCallId,
        toolName,
        input,
        output: { approved: false },
        providerExecuted: true,
        dynamic: true,
      } as RuntimeStreamPart)
      return { kind: 'reject', feedback: decision.reason || 'User rejected this action.' }
    }
    return decision.type === 'allow-always' ? { kind: 'approve-for-session' } : { kind: 'approve-once' }
  }

  // ask_user: the agent asks the user a question. Surface it as an `ask_user`
  // approval card (rendered by AskUserQuestionRenderer) and block until the UI
  // answers. The copilot request is a single question; the renderer takes a
  // questions[] array and returns answers keyed by index.
  private readonly handleUserInput: UserInputHandler = async (request): Promise<UserInputResult> => {
    const input = {
      questions: [
        {
          question: request.question,
          header: 'Question',
          type: request.choices?.length ? 'choice' : 'text',
          ...(request.choices?.length ? { options: request.choices.map((label) => ({ label })) } : {}),
        },
      ],
    }
    const { decision } = await this.requestApproval('ask_user', input)
    if (decision.type === 'deny') {
      return { answer: decision.reason || 'The user declined to answer.', wasFreeform: true }
    }
    const answers = (decision.updatedInput?.answers ?? {}) as Record<string, string>
    const answer = answers['0'] ?? Object.values(answers)[0] ?? ''
    const wasFreeform = !(request.choices ?? []).includes(answer)
    return { answer, wasFreeform }
  }

  // exit_plan_mode: the agent finished planning and wants to proceed. Surface
  // the plan as an `exit_plan_mode` approval card (rendered by PlanRenderer);
  // approve → continue with the runtime's recommended action, deny → keep
  // planning (feedback is passed back to the agent).
  private readonly handleExitPlanMode: ExitPlanModeHandler = async (request) => {
    const planContent = request.planContent || request.summary
    const { decision } = await this.requestApproval('exit_plan_mode', { plan: planContent })
    if (decision.type === 'deny') {
      return { approved: false, ...(decision.reason ? { feedback: decision.reason } : {}) }
    }
    return { approved: true, selectedAction: request.recommendedAction }
  }

  /**
   * Surface an interactive tool (`ask_user` / `exit_plan_mode`) on the active
   * turn's stream and resolve once the UI answers via resolvePermission().
   * Returns the approvalId and the user's decision, and emits the closing
   * tool-call/result so the card finalizes.
   *
   * When there is no active turn to surface UI (e.g. a worker session, or the
   * turn already ended), it falls back to a safe default rather than hanging:
   * approve plan exits, decline questions.
   */
  private async requestApproval(
    toolName: 'ask_user' | 'exit_plan_mode',
    input: Record<string, unknown>,
  ): Promise<{ approvalId: string; decision: PermissionDecision }> {
    const emit = this.activeEmit
    const approvalId = randomUUID()
    if (!emit) {
      const decision: PermissionDecision =
        toolName === 'exit_plan_mode' ? { type: 'allow' } : { type: 'deny', reason: 'No interactive UI available.' }
      return { approvalId, decision }
    }

    // Close any open assistant text/reasoning block so the card renders cleanly.
    for (const part of this.activeMapper?.flushOpenBlocks() ?? []) emit(part)

    // Emit the tool-call FIRST so the part carries the input (questions / plan)
    // by the time the approval card opens — the main UI transform drops the
    // toolCall from the approval-request chunk and reads input from the prior
    // tool-call. dynamic+providerExecuted mirror the gemini interactive shape.
    const toolCall = {
      type: 'tool-call' as const,
      toolCallId: approvalId,
      toolName,
      input,
      providerExecuted: true,
      dynamic: true,
    }
    emit({ type: 'tool-input-start', id: approvalId, toolName, providerExecuted: true, dynamic: true } as RuntimeStreamPart)
    emit(toolCall as unknown as RuntimeStreamPart)
    emit({ type: 'tool-approval-request', approvalId, toolCall } as unknown as RuntimeStreamPart)

    const decision = await new Promise<PermissionDecision>((resolve) => {
      this.pendingApprovals.set(approvalId, resolve)
    })

    // Finalize the card: a denial here is still a valid user response (decline /
    // keep planning), not a tool failure, so emit a result either way.
    const output =
      toolName === 'ask_user'
        ? { answered: decision.type !== 'deny' }
        : { approved: decision.type !== 'deny' }
    emit({
      type: 'tool-result',
      toolCallId: approvalId,
      toolName,
      input,
      output,
      providerExecuted: true,
      dynamic: true,
    } as RuntimeStreamPart)

    return { approvalId, decision }
  }

  /** Resolve every pending interactive request (on abort/teardown) so handlers don't hang. */
  private drainPendingApprovals(reason: string): void {
    if (this.pendingApprovals.size === 0) return
    for (const resolve of this.pendingApprovals.values()) resolve({ type: 'deny', reason })
    this.pendingApprovals.clear()
  }

  async *stream(params: RuntimeStreamParams): AsyncIterable<RuntimeStreamPart> {
    const prompt = buildPrompt(params.messages)
    const session = await this.ensureSession()
    const mapper = new CopilotMessageMapper()
    let unsubscribe: () => void = () => {}

    const onAbort = () => {
      void session.abort()
    }
    params.signal?.addEventListener('abort', onAbort, { once: true })

    const stream = new ReadableStream<RuntimeStreamPart>({
      start: (controller) => {
        let closed = false
        const safeClose = () => {
          if (closed) return
          closed = true
          // Unblock any handler still awaiting a UI answer; its emits are no-ops
          // now (closed), so the turn ends cleanly instead of hanging.
          this.drainPendingApprovals('Turn ended.')
          this.activeEmit = null
          this.activeMapper = null
          controller.close()
        }

        // Expose this turn's stream to the interactive handlers (ask_user /
        // exit_plan_mode), which fire via the SDK while send() is in flight.
        this.activeMapper = mapper
        this.activeEmit = (part) => {
          if (!closed) controller.enqueue(part)
        }

        // Surface the session id up-front so runAgentTurn captures it for resume.
        controller.enqueue({ type: 'message-metadata', metadata: { sessionId: session.sessionId } } as RuntimeStreamPart)

        const handler: SessionEventHandler = (event) => {
          if (closed) return
          logProviderRaw('copilot', event)
          try {
            for (const part of mapper.map(event as CopilotSessionEvent)) controller.enqueue(part)
            if (event.type === 'session.idle' || event.type === 'session.error') safeClose()
          } catch (err) {
            closed = true
            this.drainPendingApprovals('Turn errored.')
            this.activeEmit = null
            this.activeMapper = null
            controller.error(err instanceof Error ? err : new Error(String(err)))
          }
        }
        unsubscribe = session.on(handler)

        // Drive the runtime's per-turn agentMode from the selected mode:
        // interactive / plan / autopilot. Plan additionally makes the agent draft
        // a plan and request exit via onExitPlanModeRequest.
        const sendOptions = { prompt, agentMode: copilotAgentMode(this.modeId) }

        // Kick off the turn. send() resolves once the message is queued;
        // completion is driven by the session.idle event handled above. A
        // rejection here ends the turn with a synthesized finish.
        session.send(sendOptions).catch((err: unknown) => {
          if (closed) return
          const message = err instanceof Error ? err.message : String(err)
          logger.error(`send failed for session ${session.sessionId}: ${message}`)
          for (const part of mapper.finalize(message)) controller.enqueue(part)
          safeClose()
        })
      },
      cancel: () => {
        void session.abort()
      },
    })

    try {
      yield* readStreamAsAsyncIterable(stream)
    } finally {
      unsubscribe()
      this.drainPendingApprovals('Turn closed.')
      this.activeEmit = null
      this.activeMapper = null
      params.signal?.removeEventListener('abort', onAbort)
    }
  }

  getSessionId(): string | undefined {
    return this.sessionId
  }

  abort(): void {
    this.drainPendingApprovals('Aborted.')
    void this.session?.abort()
  }

  async dispose(): Promise<void> {
    this.drainPendingApprovals('Session disposed.')
    try {
      // disconnect preserves session state on disk (so it can be resumed later).
      await this.session?.disconnect()
    } catch (err) {
      logger.debug(`session disconnect failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      // forceStop, not stop: graceful stop() can hang, and disconnect already
      // flushed the session, so we just need the runtime process gone.
      await this.client?.forceStop()
    } catch (err) {
      logger.debug(`client forceStop failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    this.session = null
    this.client = null
  }

  // Tool permission is resolved inline by handlePermission (autonomous). The
  // pending requests here are the interactive callbacks (ask_user /
  // exit_plan_mode), answered by the UI through this method.
  resolvePermission(approvalId: string, decision: PermissionDecision): boolean {
    const resolve = this.pendingApprovals.get(approvalId)
    if (!resolve) return false
    this.pendingApprovals.delete(approvalId)
    resolve(decision)
    return true
  }

  /**
   * No `thinkingLevel`: effort is resolved once into `SessionConfigBase` when the
   * session is built, so changing it needs a rebuild.
   */
  async dynamicSet(payload: DynamicSetPayload): Promise<DynamicSetApplied> {
    const applied: DynamicSetApplied = []
    if (payload.modelId && payload.modelId !== this.modelId) {
      this.modelId = payload.modelId
      if (this.session) {
        try {
          await this.session.setModel(payload.modelId)
        } catch (err) {
          logger.warn(`setModel(${payload.modelId}) failed: ${err instanceof Error ? err.message : String(err)}`)
          return applied
        }
      }
      applied.push('modelId')
    }
    if (payload.modeId) {
      this.modeId = payload.modeId
      applied.push('modeId')
    }
    return applied
  }

  getDescriptorPatch(): {
    currentModelId: string
    currentModeId: string
    slashCommands?: SlashCommandItem[]
  } {
    const slashCommands = getCopilotSlashCommands(this.slashCommandState)
    return {
      currentModelId: this.modelId,
      currentModeId: this.modeId,
      ...(slashCommands.length > 0 ? { slashCommands } : {}),
    }
  }

  private ensureSession(): Promise<CopilotSession> {
    if (this.session) return Promise.resolve(this.session)
    if (!this.starting) this.starting = this.startSession()
    return this.starting
  }

  private async startSession(): Promise<CopilotSession> {
    const client = new CopilotClient({
      workingDirectory: this.cwd,
      // copilotRuntimeEnv keeps PATH/HOME etc. and sets ELECTRON_RUN_AS_NODE so a
      // `.js` runtime runs as plain Node inside Electron (see config.ts).
      env: copilotRuntimeEnv(this.env),
      // Unconditional on purpose — see resolveCopilotCliPath(). A spread that can
      // omit `connection` lets the SDK fall through to its bundled platform
      // package, which this build does not ship.
      connection: RuntimeConnection.forStdio({ path: resolveCopilotCliPath() }),
    })
    await client.start()
    this.client = client

    const reasoningEffort = this.resolveEffort()
    const config: SessionConfigBase = {
      model: this.modelId,
      workingDirectory: this.cwd,
      streaming: true,
      // Session instructions (persona) append onto the SDK-managed system
      // message. Passed on resume too — the SDK rebuilds the system message
      // from the current config, it does not persist a previous append.
      ...(this.instructions ? { systemMessage: { mode: 'append', content: this.instructions } } : {}),
      ...(this.mcpServers ? { mcpServers: this.mcpServers } : {}),
      // Registered before session.create/session.resume so early discovery
      // events cannot race past the stream listener.
      onEvent: (event) => {
        captureCopilotSlashCommands(this.slashCommandState, event)
      },
      // Only set for models that accept it (gated in resolveEffort) — the SDK
      // throws if effort is passed to a model that doesn't support it.
      ...(reasoningEffort ? { reasoningEffort } : {}),
      onPermissionRequest: this.handlePermission,
      // Enable the agent's interactive callbacks for real (human-facing)
      // sessions. Providing onUserInputRequest enables the ask_user tool;
      // onExitPlanModeRequest enables plan-mode exits. Worker sessions have no
      // UI to answer, so we leave both off to avoid the agent blocking on a
      // question nobody can see.
      ...(this.isWorker
        ? {}
        : {
            onUserInputRequest: this.handleUserInput,
            onExitPlanModeRequest: this.handleExitPlanMode,
          }),
    }
    try {
      const session = this.sessionId
        ? await client.resumeSession(this.sessionId, config)
        : await client.createSession(config)
      this.session = session
      this.sessionId = session.sessionId
      logger.info(`session ${this.sessionId} ready (model=${this.modelId}, mode=${this.modeId})`)
      return session
    } catch (err) {
      // Failed to start a session — tear the client down so we don't leak the
      // spawned runtime, and let the next stream() retry from scratch.
      this.starting = null
      await client.stop().catch(() => {})
      this.client = null
      throw err
    }
  }
}
