import type { McpServer, OpenCodeEvent } from '@opencode/client'
import { NativeEventAdapter } from './native-events.js'
import type { RuntimeContext } from '../../context.js'
import type {
  AgentInput,
  DetailedContextUsage,
  Model,
  EffortLevel,
  AgentSession,
  InjectOptions,
  McpControl,
  McpServerInfo,
  PermissionDecision,
  RuntimeStreamPart,
  SendOptions,
  SessionCloseReason,
  SessionOptions,
  SessionPatch,
  SessionPatchApplied,
} from '../../types.js'
import type { ModelMessage } from 'ai'
import { toUserMessages } from '../../utils/agent-input.js'
import { bindOpencodeCaller, unbindOpencodeCaller } from './caller-identity.js'
import { OpencodeClientManager } from './client-manager.js'
import { createAscendingMessageId } from './message-id.js'
import { extractErrorMessage, isAbortError } from './errors.js'
import {
  convertChildEventToStreamParts,
  convertEventToStreamParts,
  createFinishParts,
  createStreamState,
  getEventSessionId,
  isEventForSession,
  isSessionComplete,
  isOpencodeInternalMessage,
  mapOpencodeFinishReason,
  tryRegisterChildFromSessionEvent,
  type Message,
  type OpencodeEvent,
} from './event-stream.js'
import { getLogger, logUnsupportedCallOptions } from './logger.js'
import { convertToOpencodeMessages, isCompactCommand } from './message-mapper.js'
import type {
  OpencodeLogger,
  OpencodeMcpServerEntry,
  OpencodePartInput,
  OpencodeSettings,
  ParsedModelId,
} from './types.js'
import { isRuntimeVerbose } from '../../logger.js'
import { logProviderRaw } from '../../provider-raw-log.js'
import { SIDE_CHAT_BOUNDARY_PROMPT } from '../../side-chat-prompt.js'
type McpStatus = McpServer['status']

const AGENTS_MAP: Record<string, string> = {
  build: 'build',
  plan: 'plan',
  general: 'general',
  explore: 'explore',
  fullAccess: 'build',
}

type OpencodeClient = Awaited<ReturnType<OpencodeClientManager['getClient']>>
type OpencodeMcpApi = OpencodeClient['mcp']

type SessionMcpStatus =
  | 'pending'
  | 'connected'
  | 'disabled'
  | 'failed'
  | 'needs-auth'
  | 'needs-client-registration'
function mapMcpStatus(status: McpStatus): {
  status: SessionMcpStatus
  error?: string
} {
  switch (status.status) {
    case 'needs_auth':
      return { status: 'needs-auth' }
    case 'failed':
      return { status: 'failed', error: status.error }
    default:
      return { status: status.status }
  }
}

function parseModelId(modelId: string): ParsedModelId {
  const trimmed = modelId.trim()
  if (!trimmed) {
    throw new Error('Model ID is required')
  }
  if (!trimmed.includes('/')) {
    return { providerID: '', modelID: trimmed }
  }
  const slash = trimmed.indexOf('/')
  return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) }
}

/** The host's session instructions (persona / collab rules). */
function buildSystemPrompt(instructions?: string): string {
  return instructions?.trim() ?? ''
}

async function registerMcpServers(
  client: OpencodeClient,
  mcpServers: Record<string, OpencodeMcpServerEntry> | undefined,
  cwd: string | undefined,
  logger: OpencodeLogger,
): Promise<void> {
  if (!mcpServers) {
    logger.info('[MCP] No MCP servers to register')
    return
  }
  logger.info(`[MCP] Registering MCP servers: ${Object.keys(mcpServers).join(', ')}`)

  const location = { directory: cwd }
  const existing = await client.mcp.list({ location })
  for (const [name, entry] of Object.entries(mcpServers)) {
    if (existing.data.some((server) => server.name === name && server.status.status === 'connected')) continue
    const config = 'command' in entry
      ? { type: 'local' as const, command: [entry.command, ...(entry.args ?? [])], environment: entry.env }
      : { type: 'remote' as const, url: entry.url, headers: entry.headers }
    await client.mcp.add({ server: name, config, location })
  }
}

/** OpenCode's options block on `createSession`. */
export interface OpencodeSessionOptions {
  opencode?: {
    /**
     * The host's id for this conversation. All sessions share one OpenCode
     * server and so one MCP registration, which cannot carry a per-conversation
     * URL; the server's plugin tags each tool call with it instead — read it
     * back with `resolveOpencodeCaller`.
     */
    callerTag?: string
  }
}

/** What only OpenCode sessions offer. */
export interface OpencodeSessionNative {
  mcp: McpControl
}

export class OpencodeRuntimeSession implements AgentSession<OpencodeSessionNative> {
  private readonly cwd: string
  private currentModelId: string
  private currentModeId: string
  private currentThinkingLevel: string | undefined
  private initialized = false
  private readonly clientManager: OpencodeClientManager
  private readonly logger: OpencodeLogger
  private readonly settings: OpencodeSettings
  private sessionId: string | undefined
  private readonly hostConversationId: string | undefined
  private abortController: AbortController | null = null
  private mcpRegistered = false
  private mcpReadyPromise: Promise<void> = Promise.resolve()
  private readonly pendingApprovalIds = new Set<string>()
  private readonly questionApprovalIds = new Set<string>()
  /**
   * Side chat state: true until the branch's first prompt carries the boundary
   * marker. A side chat that already has a session id forked on an earlier turn,
   * so only a branch that has not run yet still owes one.
   */
  private boundaryPending: boolean

  constructor(params: SessionOptions & OpencodeSessionOptions, ctx: RuntimeContext) {
    this.cwd = params.cwd
    this.currentModelId = params.model ?? 'opencode/big-pickle'
    this.currentModeId = params.mode ?? 'build'
    this.currentThinkingLevel = params.effort
    this.sessionId = params.resume
    this.hostConversationId = params.opencode?.callerTag
    this.boundaryPending = params.fork != null && !params.resume
    const mcpServers = params.mcpServers as Record<string, OpencodeMcpServerEntry> | undefined
    console.log('[opencode-session] MCP servers:', mcpServers ? Object.keys(mcpServers).join(', ') : '(none)')
    this.settings = {
      cwd: params.cwd,
      env: params.env,
      sessionId: params.resume,
      forkFrom: params.fork,
      systemPrompt: buildSystemPrompt(params.instructions),
      verbose: isRuntimeVerbose(),
      mcpServers,
      tools: {
        Bash: true,
        Read: true,
        Write: true,
        Edit: true,
        Glob: true,
        Grep: true,
      },
    }
    this.clientManager = OpencodeClientManager.getInstance(ctx, {
      autoStartServer: true,
      cwd: this.cwd,
    })
    this.logger = getLogger(undefined, this.settings.verbose)
  }

  send(input: AgentInput, options?: SendOptions): AsyncIterable<RuntimeStreamPart> {
    return this.runTurn(toUserMessages(input), options?.signal)
  }

  private async *runTurn(messages: ModelMessage[], signal: AbortSignal | undefined): AsyncIterable<RuntimeStreamPart> {
    await this.mcpReadyPromise

    if (isCompactCommand(messages)) {
      yield* this.streamCompact()
      return
    }

    const warnings = logUnsupportedCallOptions(this.logger, {})
    const mode = { type: 'regular' as const }
    const converted = convertToOpencodeMessages(messages, {
      logger: this.logger,
      mode,
    })
    warnings.push(...converted.warnings)

    const sessionId = await this.getOrCreateSession()
    const client = await this.clientManager.getClient()
    if (!this.mcpRegistered) {
      await registerMcpServers(client, this.settings.mcpServers, this.settings.cwd, this.logger)
      this.mcpRegistered = true
    }
    this.logger.info(`Starting stream for session ${sessionId} with model ${this.currentModelId} in mode ${this.currentModeId}`)

    const parts = converted.parts
    const skills: Array<{ id: string }> = []
    const text = parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
      .replace(/\[skill:([^\]]+)\]/g, (_marker, id: string) => { skills.push({ id }); return '' }).trim()
    const slash = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
    const command = slash && (await this.clientManager.listCommands(this.cwd)).some((entry) => entry.name === slash[1])
      ? { name: slash[1], text: slash[2] ?? '' } : undefined
    const boundary = this.takeBoundaryParts().flatMap((part) => part.type === 'text' ? [part.text] : [])
    const requestBody = {
      sessionID: sessionId,
      text: [...boundary, command?.text ?? text].filter(Boolean).join('\n'),
      files: parts.flatMap((part) => part.type === 'file' ? [{ uri: part.url, name: part.filename }] : []),
      ...(skills.length ? { skills } : {}),
    }
    const abortController = new AbortController()
    this.abortController = abortController
    const onAbort = () => abortController.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) abortController.abort()
    yield { type: 'start' }

    const adapter = new NativeEventAdapter()
    const nativeEvents = client.event.subscribe({ signal: abortController.signal })[Symbol.asyncIterator]()
    // Subscriptions connect lazily. Wait for server.connected before admitting input.
    let promptError: string | undefined

    const state = createStreamState({
      initialStepRequest: { body: requestBody },
      initialStepWarnings: warnings.map((message) => ({ type: 'other', message })),
      modelId: this.currentModelId,
      pendingInjections: this.pendingInjections,
    })
    let lastMessageInfo: Message | undefined
    const messageErrorEmitted = new Set<string>()
    const bufferedChildEvents = new Map<string, OpencodeEvent[]>()
    let streamFailed = false
    const turnUsage = { ...state.usage }
    let measuredSteps = 0

    try {
      const connected = await nativeEvents.next()
      if (connected.done) throw new Error('OpenCode event stream did not connect')
      const admitted = command
        ? client.session.command({ ...requestBody, name: command.name })
        : client.session.prompt(requestBody)
      void admitted.catch((error: unknown) => {
        promptError = extractErrorMessage(error)
        abortController.abort()
      })
      nativeLoop: while (true) {
        const next = await nativeEvents.next()
        if (next.done) throw new Error('OpenCode event stream disconnected before the turn completed')
        const native = next.value
        logProviderRaw('opencode', native)
        if (native.type === 'session.execution.interrupted' && native.data.sessionID === sessionId) {
          yield { type: 'abort' }
          break
        }
        if (native.type === 'session.status' && native.data.sessionID === sessionId && native.data.status.type === 'retry' && native.data.status.action) {
          // Quota/auth actions require user intervention; an endless hidden retry cannot recover.
          yield { type: 'error', error: new Error(native.data.status.action.message) }
          await client.session.interrupt({ sessionID: sessionId }).catch(() => {})
          yield* createFinishParts(state, { unified: 'error', raw: 'provider-action-required' }, sessionId, this.currentModelId)
          break
        }
        if (native.type === 'session.step.started' && native.data.sessionID === sessionId) {
          state.modelId = `${native.data.model.providerID}/${native.data.model.id}`
        }
        if (native.type === 'session.step.ended' && native.data.sessionID === sessionId) {
          const { tokens, cost } = native.data
          turnUsage.inputTokens += tokens.input
          turnUsage.outputTokens += tokens.output
          turnUsage.reasoningTokens += tokens.reasoning
          turnUsage.cachedInputTokens += tokens.cache.read
          turnUsage.cachedWriteTokens += tokens.cache.write
          turnUsage.totalCost += cost
          measuredSteps++
        }
        if (native.type === 'session.inbox.delivered' && native.data.sessionID === sessionId) {
          const pending = this.pendingInjections.get(native.data.inboxID)
          if (pending) {
            this.pendingInjections.delete(native.data.inboxID)
            yield { type: 'injected-input', ...pending }
          }
        }
        if (native.type === 'form.created' && native.data.form.sessionID === sessionId) {
          const form = native.data.form
          this.pendingForms.set(form.id, form)
          this.pendingApprovalIds.add(form.id)
          yield this.formApproval(form)
        }
        if (native.type === 'permission.asked') this.approvalSessions.set(native.data.id, native.data.sessionID)
        for (const rawEvent of adapter.convert(native)) {
          if (abortController.signal.aborted) {
            if (promptError) {
              yield { type: 'error', error: new Error(promptError) }
              for (const part of createFinishParts(state, { unified: 'error', raw: 'prompt-error' }, sessionId, this.currentModelId)) {
                yield part
              }
            } else {
              await client.session.interrupt({ sessionID: sessionId }).catch(() => {})
              yield { type: 'abort' }
            }
            break nativeLoop
          }

          // Detailed event logging for debugging compact/context issues
          const eventSessionId = getEventSessionId(rawEvent)
          if (eventSessionId === sessionId || !eventSessionId) {
            this.logger.debug?.(`[stream-event] type=${rawEvent.type} props=${JSON.stringify(rawEvent.properties).slice(0, 500)}`)
          }

          const sessionForEvent = eventSessionId
          if (rawEvent.type === 'session.created' || rawEvent.type === 'session.updated') {
            const lifecycleEvent = rawEvent as Extract<OpencodeEvent, { type: 'session.created' | 'session.updated' }>
            const info = lifecycleEvent.properties.info
            if (info?.parentID === sessionId && info.id) {
              const parentCallId = tryRegisterChildFromSessionEvent(info.id, state)
              if (parentCallId) {
                const buffered = bufferedChildEvents.get(info.id)
                if (buffered) {
                  bufferedChildEvents.delete(info.id)
                  for (const bufferedEvent of buffered) {
                    for (const part of convertChildEventToStreamParts(bufferedEvent, parentCallId, state, this.logger)) {
                      yield part
                    }
                  }
                }
              }
            }
          }

          const parentCallId = sessionForEvent
            ? state.childSessions.get(sessionForEvent)
            : undefined

          if (sessionForEvent && !isEventForSession(rawEvent, sessionId) && !parentCallId) {
            if (sessionForEvent !== sessionId) {
              const buffered = bufferedChildEvents.get(sessionForEvent) ?? []
              buffered.push(rawEvent)
              bufferedChildEvents.set(sessionForEvent, buffered)
            }
            continue
          }
          if (!parentCallId && rawEvent.type === 'session.error') streamFailed = true

          if (rawEvent.type === 'message.updated') {
            const messageEvent = rawEvent as Extract<OpencodeEvent, { type: 'message.updated' }>
            const info = messageEvent.properties.info
            if (!parentCallId && info.role === 'assistant') {
              // Successful checkpoints must not replace the visible reply's finish
              // reason. Failures still need to reach the user.
              if (!isOpencodeInternalMessage(info) || info.error) lastMessageInfo = info
              if (info.error && !messageErrorEmitted.has(info.id)) {
                messageErrorEmitted.add(info.id)
                const errorData = info.error.data as { message?: string } | undefined
                const errorMessage = errorData?.message ?? info.error.name ?? 'Unknown message error'
                this.logger.error(`[message-error] ${info.error.name}: ${errorMessage}`)
                yield { type: 'error', error: new Error(errorMessage) }
              }
            }
          }

          const streamParts = parentCallId
            ? convertChildEventToStreamParts(rawEvent, parentCallId, state, this.logger)
            : convertEventToStreamParts(rawEvent, state, this.logger)

          for (const part of streamParts) {
            this.trackApproval(part)
            yield part
          }

          if (!parentCallId && bufferedChildEvents.size > 0) {
            for (const [bufferedSessionId, bufferedEvents] of bufferedChildEvents) {
              const newParentCallId = state.childSessions.get(bufferedSessionId)
              if (!newParentCallId) continue
              bufferedChildEvents.delete(bufferedSessionId)
              for (const bufferedEvent of bufferedEvents) {
                for (const part of convertChildEventToStreamParts(bufferedEvent, newParentCallId, state, this.logger)) {
                  this.trackApproval(part)
                  yield part
                }
              }
            }
          }

          if (isSessionComplete(rawEvent, sessionId)) {
            if (measuredSteps > 0) {
              state.messageUsage = turnUsage
              state.usage.totalCost = turnUsage.totalCost
            }
            const finishReason = streamFailed ? { unified: 'error' as const, raw: 'error' } : mapOpencodeFinishReason(lastMessageInfo)
            this.logger.info(`Session ${sessionId} completed with finish reason ${finishReason.unified}`)
            // If session ended without producing a message, surface the prompt error if available
            if (!lastMessageInfo && promptError) {
              this.logger.error(`Session ${sessionId} ended with no output. Provider error: ${promptError}`)
              yield { type: 'error', error: new Error(promptError) }
            }
            for (const part of createFinishParts(state, finishReason, sessionId, this.currentModelId)) {
              yield part
            }
            break nativeLoop
          }
        }
      }
    } catch (error) {
      if (promptError) {
        yield { type: 'error', error: new Error(promptError) }
      } else if (abortController.signal.aborted) {
        await client.session.interrupt({ sessionID: sessionId }).catch(() => {})
        yield { type: 'abort' }
      } else if (!isAbortError(error)) {
        await client.session.interrupt({ sessionID: sessionId }).catch(() => {})
        yield { type: 'error', error }
      }
      if (promptError || !abortController.signal.aborted) {
        yield* createFinishParts(state, { unified: 'error', raw: 'stream-error' }, sessionId, this.currentModelId)
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      await nativeEvents.return?.()
      this.abortController = null
    }
  }

  abort(): void {
    this.logger.info('Abort requested')
    this.abortController?.abort()
    this.abortController = null
    this.pendingApprovalIds.clear()
    this.questionApprovalIds.clear()
  }

  /** The boundary marker, once, for a side chat's opening prompt. */
  private takeBoundaryParts(): OpencodePartInput[] {
    if (!this.boundaryPending) return []
    this.boundaryPending = false
    return [{ type: 'text', text: SIDE_CHAT_BOUNDARY_PROMPT }]
  }

  async close(reason: SessionCloseReason = 'discard'): Promise<void> {
    this.abort()
    // A rebuild hands the same OpenCode session to its replacement, which may
    // already have bound it; only a discarded conversation gives the id up.
    if (reason === 'discard' && this.sessionId && this.hostConversationId) {
      unbindOpencodeCaller(this.sessionId, this.hostConversationId)
    }
    // A rebuild keeps the conversation and its fork while replacing host state.
    // resumes it by id.
    if (reason === 'discard') await this.discardEphemeralFork()
  }

  /**
   * Delete the branch a side chat forked for itself.
   *
   * Codex's forks are ephemeral by construction — they never touch disk — but
   * OpenCode's are ordinary sessions, so an abandoned side chat would leave one
   * in the session list forever. Disposal is where a side chat ends (the chat row
   * goes with it), so this is the last chance to clean up.
   *
   * The id compared against is the parent's, so this can only ever delete a
   * branch this session forked, never the conversation it came from.
   */
  private async discardEphemeralFork(): Promise<void> {
    const source = this.settings.forkFrom
    if (!source || source.ephemeral === false) return
    const forkedId = this.sessionId
    if (!forkedId || forkedId === source.from) return
    this.sessionId = undefined
    try {
      const client = await this.clientManager.getClient()
      await client.session.remove({ sessionID: forkedId })
      this.logger.info(`Deleted side chat fork ${forkedId}`)
    } catch (error) {
      this.logger.warn(`Failed to delete side chat fork ${forkedId}: ${extractErrorMessage(error)}`)
    }
  }

  /** Admission is asynchronous; wait for compaction and inspect its persisted result. */
  private async *streamCompact(): AsyncIterable<RuntimeStreamPart> {
    if (!this.sessionId) {
      this.logger.warn('No active session to compact')
      return
    }
    this.logger.info(`Running compact for session ${this.sessionId}`)
    const client = await this.clientManager.getClient()
    yield { type: 'start' }
    const state = createStreamState({ modelId: this.currentModelId })
    state.stepStarted = true
    yield { type: 'start-step', request: { body: { command: '/compact' } }, warnings: [] }

    let compactError: Error | undefined
    try {
      await client.session.compact({ sessionID: this.sessionId })
      await client.session.wait({ sessionID: this.sessionId })
      const messages = await client.session.context({ sessionID: this.sessionId })
      const latest = messages.at(-1)
      if (latest?.type === 'compaction' && latest.status === 'failed') {
        compactError = new Error(latest.error.message)
      }

      if (compactError) {
        yield { type: 'error', error: compactError }
      } else {
        this.logger.info(`Compact completed for session ${this.sessionId}`)
      }
    } catch (error) {
      this.logger.error(`[compact] session.compact failed: ${extractErrorMessage(error)}`)
      this.logger.debug?.(`[compact] Full error: ${JSON.stringify(error)}`)
      yield { type: 'error', error: error instanceof Error ? error : new Error(extractErrorMessage(error)) }
      compactError = error instanceof Error ? error : new Error(extractErrorMessage(error))
    }

    state.compacted = !compactError
    const finishReason = compactError
      ? { unified: 'error' as const, raw: 'compact-error' }
      : { unified: 'stop' as const, raw: 'stop' }
    for (const part of createFinishParts(state, finishReason, this.sessionId, this.currentModelId)) {
      yield part
    }
  }

  respond(approvalId: string, decision: PermissionDecision): boolean {
    if (!this.pendingApprovalIds.delete(approvalId)) return false
    void this.replyPermission(approvalId, decision)
    return true
  }

  private trackApproval(part: RuntimeStreamPart): void {
    if (part.type !== 'tool-approval-request') return
    this.pendingApprovalIds.add(part.approvalId)
    if (part.toolCall.toolName === 'AskUserQuestion' || part.toolCall.toolName === 'ask_user') {
      this.questionApprovalIds.add(part.approvalId)
    }
  }

  get id(): string | undefined {
    return this.sessionId
  }

  /**
   * Messages added with `inject` that no step has answered yet, by the OpenCode
   * message id they were sent with (see `StreamState.pendingInjections`).
   */
  private readonly pendingInjections = new Map<string, { id: string; text: string }>()

  async inject(content: string, options?: InjectOptions): Promise<void> {
    await this.mcpReadyPromise
    const sessionId = await this.getOrCreateSession()
    const client = await this.clientManager.getClient()
    this.logger.info(`Injecting follow-up into session ${sessionId}`)
    // Our own id, so the step that answers it (its `parentID`) can be recognised.
    const messageID = createAscendingMessageId()
    if (options?.id) this.pendingInjections.set(messageID, { id: options.id, text: content })
    try {
      await client.session.prompt({ sessionID: sessionId, id: messageID, text: content, delivery: 'steer' })
    } catch (error) {
      this.pendingInjections.delete(messageID)
      throw error
    }
  }

  readonly native: OpencodeSessionNative = {
    mcp: {
      list: () => this.listMcpServers(),
      reconnect: (name) =>
        this.runMcpMutation(name, async () => {
          const mcp = (await this.clientManager.getClient()).mcp
          await mcp.connect({ server: name, location: { directory: this.cwd } })
          await this.waitForMcpStatus(mcp, name, 'connected')
        }),
      toggle: (name, enabled) =>
        this.runMcpMutation(name, async () => {
          const mcp = (await this.clientManager.getClient()).mcp
          if (enabled) {
            await mcp.connect({ server: name, location: { directory: this.cwd } })
            await this.waitForMcpStatus(mcp, name, 'connected')
          } else {
            await mcp.disconnect({ server: name, location: { directory: this.cwd } })
            await this.waitForMcpStatus(mcp, name, 'disabled')
          }
        }),
    },
  }

  private async listMcpServers(): Promise<McpServerInfo[]> {
    const client = await this.clientManager.getClient()
    const result = await client.mcp.list({ location: { directory: this.cwd } })
    const configured = this.settings.mcpServers
    return result.data.map(({ name, status: rawStatus }) => {
      const mapped = mapMcpStatus(rawStatus)
      const entry = configured?.[name]
      const transport = !entry?.type || entry.type === 'stdio' ? 'stdio' : entry.type
      return {
        name,
        status: mapped.status,
        ...(entry ? { transport } : {}),
        ...(mapped.error ? { error: mapped.error } : {}),
      }
    })
  }

  private async runMcpMutation(
    name: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    if (this.abortController) {
      throw new Error('Wait for the current turn to finish before changing MCP servers')
    }

    const mutation = this.mcpReadyPromise.then(operation)
    this.mcpReadyPromise = mutation.catch((error: unknown) => {
      this.logger.warn(
        `MCP control failed for "${name}": ${error instanceof Error ? error.message : String(error)}; proceeding`,
      )
    })
    await mutation
  }

  private async waitForMcpStatus(
    mcp: OpencodeMcpApi,
    name: string,
    expected: 'connected' | 'disabled',
    timeoutMs = 15_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const result = await mcp.list({ location: { directory: this.cwd } })
      const status = result.data.find((server) => server.name === name)?.status
      if (status?.status === expected) return
      if (status?.status === 'failed') {
        throw new Error(status.error)
      }
      if (status?.status === 'needs_auth') {
        throw new Error(`MCP server "${name}" needs authentication`)
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error(`MCP server "${name}" did not become ${expected} within ${timeoutMs}ms`)
  }

  /** V2 switches apply to subsequent provider requests, including an active loop. */
  async set(patch: SessionPatch): Promise<SessionPatchApplied> {
    const applied: SessionPatchApplied = []
    const client = this.sessionId ? await this.clientManager.getClient() : undefined
    if (patch.model || patch.effort) {
      const model = parseModelId(patch.model ?? this.currentModelId)
      let effort = patch.effort ?? this.currentThinkingLevel
      if (client && patch.model && patch.model !== this.currentModelId && !patch.effort && effort) {
        const models = await client.model.list({ location: { directory: this.cwd } })
        const target = models.data.find((entry) => entry.providerID === model.providerID && entry.id === model.modelID)
        if (target && !target.variants.some((variant) => variant.id === effort)) effort = undefined
      }
      if (!model.providerID) throw new Error('OpenCode models must include their provider ID')
      if (client && this.sessionId) await client.session.switchModel({
        sessionID: this.sessionId,
        model: { id: model.modelID, providerID: model.providerID, variant: effort },
      })
      if (patch.model) { this.currentModelId = patch.model; applied.push('model') }
      this.currentThinkingLevel = effort
      if (patch.effort) applied.push('effort')
    }
    if (patch.mode) {
      if (client && this.sessionId) {
        await client.session.switchAgent({ sessionID: this.sessionId, agent: AGENTS_MAP[patch.mode] ?? patch.mode })
        await client.session.update({ sessionID: this.sessionId, permissions: patch.mode === 'fullAccess' ? [{ action: '*', resource: '*', effect: 'allow' }] : [] })
      }
      this.currentModeId = patch.mode
      applied.push('mode')
    }
    return applied
  }

  private async getOrCreateSession(): Promise<string> {
    const sessionId = await this.resolveSession()
    if (this.hostConversationId) bindOpencodeCaller(sessionId, this.hostConversationId)
    if (!this.initialized) {
      await this.set({ model: this.currentModelId, mode: this.currentModeId, effort: this.currentThinkingLevel })
      const client = await this.clientManager.getClient()
      if (this.settings.systemPrompt) await client.session.instructions.entry.put({ sessionID: sessionId, key: 'operon', value: this.settings.systemPrompt })
      this.initialized = true
    }
    return sessionId
  }

  private async resolveSession(): Promise<string> {
    if (this.sessionId && !this.settings.createNewSession) {
      this.logger.info(`Reusing session ${this.sessionId}`)
      return this.sessionId
    }
    const client = await this.clientManager.getClient()

    // A side chat branches off its parent exactly once. `session.fork` copies the
    // parent's messages into a new session, so the model inherits the history
    // while this conversation keeps its own transcript and its own id — the two
    // never write back to each other. From the next turn on `this.sessionId` is
    // the branch's id and the check above short-circuits.
    //
    // The branch is a sibling, not a child: `Session.fork` creates it without a
    // `parentID`, so a parent that happens to be mid-turn never mistakes it for
    // sub-agent output on the shared event stream.
    //
    // `fork.afterTurn` is deliberately NOT forwarded as `messageID`. The two
    // mean opposite things — codex branches *after* the turn it names, while
    // OpenCode slices the history to *before* the message it names — so passing it
    // through would silently drop the last turn. Nothing sets it today; a side
    // chat always branches at the tail.
    const source = this.settings.forkFrom
    if (source && !this.settings.createNewSession) {
      this.logger.info(`Forking session ${source.from} for a side chat`)
      const forked = await client.session.fork({
        sessionID: source.from,
      })
      const forkedId = forked.id
      if (!forkedId) {
        throw new Error('Failed to fork OpenCode session')
      }
      this.sessionId = forkedId
      this.logger.info(`Forked session ${forkedId}`)
      return forkedId
    }

    const result = await client.session.create({
      title: this.settings.sessionTitle ?? 'Operon',
      location: { directory: this.cwd },
    })
    const data = result
    if (!data?.id) {
      throw new Error('Failed to create OpenCode session')
    }
    this.sessionId = data.id
    this.logger.info(`Created session ${this.sessionId}`)
    return this.sessionId
  }

  private async replyPermission(approvalId: string, decision: PermissionDecision): Promise<void> {
    if (!this.sessionId) return
    const client = await this.clientManager.getClient()
    const updatedInput =
      decision.type === 'allow' || decision.type === 'allow-always'
        ? decision.updatedInput
        : undefined
    const form = this.pendingForms.get(approvalId)
    if (form) {
      this.pendingForms.delete(approvalId)
      if (decision.type === 'deny') {
        await client.session.form.cancel({ sessionID: form.sessionID, formID: form.id, message: decision.reason })
      } else {
        const raw = (updatedInput?.answers ?? {}) as Record<string, string>
        const answer: Record<string, string | string[] | number | boolean> = {}
        for (const field of form.fields) {
          if ('hidden' in field && field.hidden) continue
          const value = raw[field.title ?? field.key] ?? raw[field.key] ?? ''
          const optionValue = (label: string): string => 'options' in field
            ? field.options?.find((option) => option.label === label)?.value ?? label : label
          answer[field.key] = field.type === 'multiselect' ? value.split(',').map((part) => optionValue(part.trim())).filter(Boolean)
            : field.type === 'number' || field.type === 'integer' ? Number(value)
              : field.type === 'boolean' ? value === 'true' || value === 'Yes' : optionValue(value)
        }
        await client.session.form.reply({ sessionID: form.sessionID, formID: form.id, answer })
      }
      return
    }
    await client.permission.reply({
      sessionID: this.approvalSessions.get(approvalId) ?? this.sessionId,
      requestID: approvalId,
      decision: decision.type === 'deny' ? 'reject' : decision.type === 'allow-always' ? 'always' : 'once',
      message: decision.type === 'deny' ? decision.reason : undefined,
    })
    this.approvalSessions.delete(approvalId)
  }

  private readonly pendingForms = new Map<string, Extract<OpenCodeEvent, { type: 'form.created' }>['data']['form']>()
  private readonly approvalSessions = new Map<string, string>()

  private formApproval(form: Extract<OpenCodeEvent, { type: 'form.created' }>['data']['form']): Extract<RuntimeStreamPart, { type: 'tool-approval-request' }> {
    const questions = form.fields.filter((field) => !('hidden' in field && field.hidden)).map((field) => ({
      question: field.title ?? field.key, header: field.title ?? field.key,
      options: 'options' in field ? (field.options ?? []).map((option) => ({ label: option.label ?? String(option.value), description: option.description ?? '' })) : [],
      multiSelect: field.type === 'multiselect', custom: true,
    }))
    return { type: 'tool-approval-request', approvalId: form.id, toolCall: {
      type: 'tool-call', toolCallId: form.id, toolName: 'AskUserQuestion', input: JSON.stringify({ questions }),
      providerExecuted: true, dynamic: true,
    } }
  }

  async contextUsage(): Promise<DetailedContextUsage | null> {
    if (!this.sessionId) return null
    const client = await this.clientManager.getClient()
    const [messages, models, config] = await Promise.all([
      client.session.context({ sessionID: this.sessionId }), client.model.list({ location: { directory: this.cwd } }),
      client.config.get({ location: { directory: this.cwd } }),
    ])
    const latest = [...messages].reverse().find((message) => message.type === 'assistant' && message.tokens)
    if (latest?.type !== 'assistant' || !latest.tokens) return null
    const tokens = latest.tokens
    const model = models.data.find((model) => `${model.providerID}/${model.id}` === this.currentModelId)
    if (!model) return null
    const used = tokens.input + tokens.cache.read + tokens.cache.write
    const max = model.limit.context
    const autoCompact = config.reduce((enabled, entry) => entry.type === 'document' ? entry.info.compaction?.auto ?? enabled : enabled, true)
    return {
      categories: [{ name: 'Context', tokens: used, color: 'messages', kind: 'used' }, { name: 'Free', tokens: Math.max(0, max - used), color: 'free', kind: 'free' }],
      totalTokens: used, maxTokens: max, rawMaxTokens: max, percentage: max > 0 ? Math.min(100, used / max * 100) : 0,
      model: this.currentModelId, memoryFiles: [], isAutoCompactEnabled: autoCompact,
      apiUsage: { input_tokens: tokens.input, output_tokens: tokens.output, cache_creation_input_tokens: tokens.cache.write, cache_read_input_tokens: tokens.cache.read },
    }
  }

  state(): {
    currentModelId: string
    currentModeId: string
    currentThinkingLevel: string | undefined
  } {
    return {
      currentModelId: this.currentModelId,
      currentModeId: this.currentModeId,
      currentThinkingLevel: this.currentThinkingLevel,
    }
  }
}

export async function listOpencodeDescriptorModels(ctx: RuntimeContext, cwd: string, currentModelId: string): Promise<{ models: Model[]; currentModelId: string }> {
  const client = await OpencodeClientManager.getInstance(ctx, { autoStartServer: true, cwd }).getClient()
  const location = { directory: cwd }
  // Model discovery initializes the native provider catalog on a cold V2 server.
  const result = await client.model.list({ location })
  const providers = await client.provider.list({ location }).catch(() => ({ data: [] }))
  const providerById = new Map(providers.data.map((provider) => [provider.id, provider]))
  const levels: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
  const models: Model[] = result.data.filter((model) => model.enabled).map((model) => ({
    id: `${model.providerID}/${model.id}`, name: model.name, contextWindow: model.limit.context,
    providerLabel: providerById.get(model.providerID)?.name ?? model.providerID,
    providerLogo: providerById.get(model.providerID)?.canonical ?? model.providerID,
    supportedEffortLevels: levels.filter((level) => model.variants.some((variant) => variant.id === level)),
  }))
  return { models, currentModelId: models.some((model) => model.id === currentModelId) ? currentModelId : models[0]?.id ?? currentModelId }
}
