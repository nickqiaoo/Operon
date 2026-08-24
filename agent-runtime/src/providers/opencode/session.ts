import { getRuntimeHost } from '../../host.js'
import { MEMORY_RESOLVER_PROMPT, FILE_REFERENCE_PROMPT } from '../../memory-resolver-prompt.js'
import type {
  DynamicSetApplied,
  DynamicSetPayload,
  PermissionDecision,
  RuntimeSession,
  RuntimeSessionParams,
  RuntimeStreamPart,
  RuntimeStreamParams,
} from '../../types.js'
import { OpencodeClientManager } from './client-manager.js'
import { extractErrorMessage, isAbortError } from './errors.js'
import {
  convertChildEventToStreamParts,
  convertEventToStreamParts,
  createFinishParts,
  createStreamState,
  getEventSessionId,
  isEventForSession,
  isSessionComplete,
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
  OpencodeSettings,
  ParsedModelId,
  ProviderListResponse,
} from './types.js'
import { isRuntimeVerbose } from '../../logger.js'
import { logProviderRaw } from '../../provider-raw-log.js'
import { applyRuntimeEnv } from '../../runtime-env.js'
import type { McpStatus } from '@opencode-ai/sdk/v2'

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
  | 'connected'
  | 'disabled'
  | 'failed'
  | 'needs-auth'
  | 'needs-client-registration'

function readControlName(params: unknown): string {
  if (!params || typeof params !== 'object') throw new Error('MCP server name is required')
  const name = (params as Record<string, unknown>).name
  if (typeof name !== 'string' || !name.trim()) throw new Error('MCP server name is required')
  return name.trim()
}

function readControlEnabled(params: unknown): boolean {
  if (!params || typeof params !== 'object') throw new Error('MCP enabled state is required')
  const enabled = (params as Record<string, unknown>).enabled
  if (typeof enabled !== 'boolean') throw new Error('MCP enabled state is required')
  return enabled
}

function mapMcpStatus(status: McpStatus): {
  status: SessionMcpStatus
  error?: string
} {
  switch (status.status) {
    case 'needs_auth':
      return { status: 'needs-auth' }
    case 'needs_client_registration':
      return { status: 'needs-client-registration', error: status.error }
    case 'failed':
      return { status: 'failed', error: status.error }
    default:
      return { status: status.status }
  }
}

function ensureOpencodeInPath(): void {
  const opencodePath = getRuntimeHost().resolveCliPath('opencode')
  if (!opencodePath) return
  const separatorIndex = opencodePath.lastIndexOf('/')
  const directory = separatorIndex >= 0 ? opencodePath.slice(0, separatorIndex) : ''
  if (directory && !process.env.PATH?.includes(directory)) {
    process.env.PATH = `${directory}:${process.env.PATH ?? ''}`
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
  const parts = trimmed.split('/')
  const modelName = parts.pop() ?? trimmed
  return {
    providerID: parts.join('/'),
    modelID: modelName,
  }
}

/** Memory prompts plus the host's session instructions (persona / collab rules). */
function buildSystemPrompt(instructions?: string): string {
  return [MEMORY_RESOLVER_PROMPT, FILE_REFERENCE_PROMPT, instructions?.trim()].filter(Boolean).join('\n\n')
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

  const mcp = (client as { mcp?: OpencodeMcpApi }).mcp
  if (!mcp?.add) {
    logger.warn('[MCP] client.mcp.add not available')
    return
  }

  let existingStatus: Record<string, { status: string }> = {}
  try {
    existingStatus = (await mcp.status({ directory: cwd })).data ?? {}
  } catch {}

  for (const [name, entry] of Object.entries(mcpServers)) {
    if (existingStatus[name]?.status === 'connected') continue
    try {
      const config = !entry.type || entry.type === 'stdio'
          ? {
            type: 'local' as const,
            command: [entry.command, ...(entry.args ?? [])],
            environment: entry.env,
            enabled: true,
          }
        : (() => {
            const remoteEntry = entry as Extract<OpencodeMcpServerEntry, { type: 'http' | 'sse' }>
            return {
              type: 'remote' as const,
              url: remoteEntry.url,
              headers: remoteEntry.headers,
              enabled: true,
            }
          })()

      const addResult = await mcp.add({ name, config, directory: cwd })
      const serverStatus = addResult.data?.[name]?.status
      logger.info(`[MCP] Added "${name}", status: ${serverStatus ?? 'unknown'}`)
      if (serverStatus && serverStatus !== 'connected') {
        await mcp.connect({ name, directory: cwd }).catch((error) => {
          logger.warn(`[MCP] Failed to connect server "${name}": ${extractErrorMessage(error)}`)
        })
      }
    } catch (error) {
      logger.warn(`[MCP] Failed to register server "${name}": ${extractErrorMessage(error)}`)
    }
  }
}

export class OpencodeRuntimeSession implements RuntimeSession {
  private readonly cwd: string
  private currentModelId: string
  private currentModeId: string
  private readonly clientManager: OpencodeClientManager
  private readonly logger: OpencodeLogger
  private readonly settings: OpencodeSettings
  private sessionId: string | undefined
  private abortController: AbortController | null = null
  private mcpRegistered = false
  private mcpReadyPromise: Promise<void> = Promise.resolve()
  private readonly pendingApprovalIds = new Set<string>()
  private readonly questionApprovalIds = new Set<string>()

  constructor(params: RuntimeSessionParams) {
    ensureOpencodeInPath()
    this.cwd = params.cwd
    this.currentModelId = params.modelId ?? 'opencode/big-pickle'
    this.currentModeId = params.modeId ?? 'build'
    this.sessionId = params.sessionId
    const mcpServers = params.mcpServers as Record<string, OpencodeMcpServerEntry> | undefined
    console.log('[opencode-session] MCP servers:', mcpServers ? Object.keys(mcpServers).join(', ') : '(none)')
    this.settings = {
      cwd: params.cwd,
      env: params.env,
      sessionId: params.sessionId,
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
    this.clientManager = OpencodeClientManager.getInstance({
      autoStartServer: true,
      cwd: this.cwd,
    })
    this.logger = getLogger(undefined, this.settings.verbose)
  }

  async *stream(params: RuntimeStreamParams): AsyncIterable<RuntimeStreamPart> {
    applyRuntimeEnv(this.settings.env)
    await this.mcpReadyPromise

    if (isCompactCommand(params.messages)) {
      yield* this.streamCompact()
      return
    }

    const warnings = logUnsupportedCallOptions(this.logger, {})
    const mode = { type: 'regular' as const }
    const converted = convertToOpencodeMessages(params.messages, {
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

    const parsedModelId = parseModelId(this.currentModelId)
    const requestBody = {
      model: parsedModelId.providerID
        ? {
            providerID: parsedModelId.providerID,
            modelID: parsedModelId.modelID,
          }
        : undefined,
      agent: AGENTS_MAP[this.currentModeId] ?? 'build',
      system: this.settings.systemPrompt,
      parts: converted.parts,
      tools: this.settings.tools,
    }

    const abortController = new AbortController()
    this.abortController = abortController
    if (params.signal) {
      params.signal.addEventListener('abort', () => abortController.abort(), { once: true })
    }

    yield { type: 'start' }

    const eventStreamResult = await client.event.subscribe({ directory: this.settings.cwd })
    const eventStream = eventStreamResult.stream
    if (!eventStream) {
      yield { type: 'error', error: new Error('Failed to subscribe to OpenCode events') }
      return
    }
    this.logger.debug?.(`Subscribed to event stream for session ${sessionId}`)

    let promptError: string | undefined
    this.logger.debug?.(`[prompt] Sending prompt to session ${sessionId}, parts=${JSON.stringify(requestBody.parts).slice(0, 500)}`)
    void client.session.prompt({
      sessionID: sessionId,
      directory: this.settings.cwd,
      ...requestBody,
    }).then(() => {
      this.logger.debug?.(`[prompt] session.prompt returned for session ${sessionId}`)
    }).catch((error) => {
      promptError = extractErrorMessage(error)
      this.logger.error(`Prompt error: ${promptError}`)
      // Abort the event loop so the error gets surfaced
      abortController.abort()
    })

    const state = createStreamState({
      initialStepRequest: { body: requestBody },
      initialStepWarnings: warnings.map((message) => ({ type: 'other', message })),
      modelId: this.currentModelId,
    })
    let lastMessageInfo: Message | undefined
    const messageErrorEmitted = new Set<string>()
    const bufferedChildEvents = new Map<string, OpencodeEvent[]>()

    try {
      for await (const rawEvent of eventStream as AsyncIterable<OpencodeEvent>) {
        logProviderRaw('opencode', rawEvent)
        if (abortController.signal.aborted) {
          if (promptError) {
            yield { type: 'error', error: new Error(promptError) }
            for (const part of createFinishParts(state, { unified: 'error', raw: 'prompt-error' }, sessionId, this.currentModelId)) {
              yield part
            }
          } else {
            await client.session.abort({ sessionID: sessionId }).catch(() => {})
            yield { type: 'abort' }
          }
          break
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

        if (rawEvent.type === 'message.updated') {
          const messageEvent = rawEvent as Extract<OpencodeEvent, { type: 'message.updated' }>
          const info = messageEvent.properties.info
          if (info.role === 'assistant') {
            lastMessageInfo = info
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
          const finishReason = mapOpencodeFinishReason(lastMessageInfo)
          this.logger.info(`Session ${sessionId} completed with finish reason ${finishReason.unified}`)
          // If session ended without producing a message, surface the prompt error if available
          if (!lastMessageInfo && promptError) {
            this.logger.error(`Session ${sessionId} ended with no output. Provider error: ${promptError}`)
            yield { type: 'error', error: new Error(promptError) }
          }
          for (const part of createFinishParts(state, finishReason, sessionId, this.currentModelId)) {
            yield part
          }
          break
        }
      }
    } catch (error) {
      if (!isAbortError(error)) {
        yield { type: 'error', error }
      }
    } finally {
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

  async dispose(): Promise<void> {
    this.abort()
  }

  /**
   * Compact is a blocking API call (session.summarize) that resolves normally
   * even when compaction fails due to context overflow — opencode stores the
   * error on the last assistant message instead of rejecting the promise.
   * So after summarize returns, we fetch the latest message and check its error field.
   */
  private async *streamCompact(): AsyncIterable<RuntimeStreamPart> {
    if (!this.sessionId) {
      this.logger.warn('No active session to compact')
      return
    }
    this.logger.info(`Running compact for session ${this.sessionId}`)
    const client = await this.clientManager.getClient()
    const parsedModelId = parseModelId(this.currentModelId)

    yield { type: 'start' }
    const state = createStreamState({ modelId: this.currentModelId })
    state.stepStarted = true
    yield { type: 'start-step', request: { body: { command: '/compact' } }, warnings: [] }

    let compactError: Error | undefined
    try {
      this.logger.debug?.(`[compact] Calling session.summarize with sessionID=${this.sessionId}, providerID=${parsedModelId.providerID}, modelID=${parsedModelId.modelID}`)
      const summarizeResult = await client.session.summarize({
        sessionID: this.sessionId,
        providerID: parsedModelId.providerID,
        modelID: parsedModelId.modelID,
      })
      this.logger.debug?.(`[compact] session.summarize returned: ${JSON.stringify(summarizeResult, null, 2)}`)

      // summarize() resolves normally even on ContextOverflowError.
      // Check the latest assistant message for an error field.
      try {
        const messagesResult = await (client as unknown as {
          session: { messages: (params: { sessionID: string; directory?: string }) => Promise<{ data?: Array<{ info: Message }> }> }
        }).session.messages({ sessionID: this.sessionId, directory: this.settings.cwd })
        const messages = messagesResult.data ?? []
        for (let i = messages.length - 1; i >= 0; i--) {
          const info = messages[i]?.info
          if (info?.role === 'assistant') {
            if (info.error) {
              const errorData = info.error.data as { message?: string } | undefined
              const errorMessage = errorData?.message ?? info.error.name ?? 'Compact failed'
              compactError = new Error(errorMessage)
              this.logger.error(`[compact] Detected error on latest message: ${info.error.name}: ${errorMessage}`)
            }
            break
          }
        }
      } catch (fetchError) {
        this.logger.warn(`[compact] Failed to fetch messages for error check: ${extractErrorMessage(fetchError)}`)
      }

      if (compactError) {
        yield { type: 'error', error: compactError }
      } else {
        this.logger.info(`Compact completed for session ${this.sessionId}`)
      }
    } catch (error) {
      this.logger.error(`[compact] session.summarize FAILED: ${extractErrorMessage(error)}`)
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

  resolvePermission(approvalId: string, decision: PermissionDecision): boolean {
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

  getSessionId(): string | undefined {
    return this.sessionId
  }

  async injectMessage(content: string): Promise<void> {
    await this.mcpReadyPromise
    const sessionId = await this.getOrCreateSession()
    const client = await this.clientManager.getClient()
    this.logger.info(`Injecting follow-up into session ${sessionId}`)
    await client.session.promptAsync({
      sessionID: sessionId,
      directory: this.settings.cwd,
      parts: [{ type: 'text', text: content }],
    })
  }

  async agentControl(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'mcp.list': {
        const client = await this.clientManager.getClient()
        const mcp = client.mcp
        const result = await mcp.status({ directory: this.cwd }, { throwOnError: true })
        const configured = this.settings.mcpServers
        return {
          servers: Object.entries(result.data).map(([name, rawStatus]) => {
            const mapped = mapMcpStatus(rawStatus)
            const entry = configured?.[name]
            const transport = !entry?.type || entry.type === 'stdio' ? 'stdio' : entry.type
            return {
              name,
              status: mapped.status,
              ...(entry ? { transport } : {}),
              ...(mapped.error ? { error: mapped.error } : {}),
            }
          }),
        }
      }
      case 'mcp.reconnect': {
        const name = readControlName(params)
        await this.runMcpMutation(name, async () => {
          const mcp = (await this.clientManager.getClient()).mcp
          await mcp.connect({ name, directory: this.cwd }, { throwOnError: true })
          await this.waitForMcpStatus(mcp, name, 'connected')
        })
        return { ok: true }
      }
      case 'mcp.toggle': {
        const name = readControlName(params)
        const enabled = readControlEnabled(params)
        await this.runMcpMutation(name, async () => {
          const mcp = (await this.clientManager.getClient()).mcp
          if (enabled) {
            await mcp.connect({ name, directory: this.cwd }, { throwOnError: true })
            await this.waitForMcpStatus(mcp, name, 'connected')
          } else {
            await mcp.disconnect({ name, directory: this.cwd }, { throwOnError: true })
            await this.waitForMcpStatus(mcp, name, 'disabled')
          }
        })
        return { ok: true }
      }
      default:
        throw new Error(`Unsupported OpenCode session control method: ${method}`)
    }
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
      const result = await mcp.status({ directory: this.cwd }, { throwOnError: true })
      const status = result.data[name]
      if (status?.status === expected) return
      if (status?.status === 'failed') {
        throw new Error(status.error)
      }
      if (status?.status === 'needs_auth') {
        throw new Error(`MCP server "${name}" needs authentication`)
      }
      if (status?.status === 'needs_client_registration') {
        throw new Error(status.error)
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error(`MCP server "${name}" did not become ${expected} within ${timeoutMs}ms`)
  }

  /** Both are read fresh when the next request body is built, so storing them is enough. */
  async dynamicSet(payload: DynamicSetPayload): Promise<DynamicSetApplied> {
    const applied: DynamicSetApplied = []
    if (payload.modelId) {
      this.currentModelId = payload.modelId
      applied.push('modelId')
    }
    if (payload.modeId) {
      this.currentModeId = payload.modeId
      applied.push('modeId')
    }
    return applied
  }

  private async getOrCreateSession(): Promise<string> {
    if (this.sessionId && !this.settings.createNewSession) {
      this.logger.info(`Reusing session ${this.sessionId}`)
      return this.sessionId
    }
    const client = await this.clientManager.getClient()
    const result = await client.session.create({
      title: this.settings.sessionTitle ?? 'XUI Session',
      directory: this.settings.cwd,
    })
    const data = result.data as { id?: string } | undefined
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
    const isQuestionResponse =
      this.questionApprovalIds.has(approvalId) ||
      (
        !!updatedInput &&
        'questions' in updatedInput &&
        Array.isArray(updatedInput.questions) &&
        'answers' in updatedInput
      )

    if (isQuestionResponse) {
      const questionClient = (client as unknown as {
        question?: {
          reply: (opts: { requestID: string; directory?: string; answers: string[][] }) => Promise<unknown>
          reject?: (opts: { requestID: string; directory?: string }) => Promise<unknown>
        }
      }).question

      if (!questionClient) {
        this.logger.warn(`Question API not available for approval ${approvalId}`)
        return
      }

      if (decision.type === 'deny') {
        this.logger.info(`Rejecting question ${approvalId}`)
        this.questionApprovalIds.delete(approvalId)
        await questionClient.reject?.({
          requestID: approvalId,
          directory: this.settings.cwd,
        }).catch((error) => {
          this.logger.error(`Failed to reject question ${approvalId}: ${extractErrorMessage(error)}`)
        })
        return
      }

      const rawAnswers = (updatedInput?.answers ?? {}) as Record<string, string>
      const questions = (updatedInput?.questions ?? []) as Array<{ question: string }>
      const answers = questions.map((question) => {
        const answer = rawAnswers[question.question] ?? ''
        return answer ? [answer] : []
      })

      this.logger.info(`Replying to question ${approvalId}`)
      this.questionApprovalIds.delete(approvalId)
      await questionClient.reply({
        requestID: approvalId,
        directory: this.settings.cwd,
        answers,
      }).catch((error) => {
        this.logger.error(`Failed to reply to question ${approvalId}: ${extractErrorMessage(error)}`)
      })
      return
    }

    const permissionReply = decision.type === 'deny' ? 'reject' : decision.type === 'allow-always' ? 'always' : 'once'
    await client.permission.reply({
      requestID: approvalId,
      directory: this.settings.cwd,
      reply: permissionReply,
      message: decision.type === 'deny' ? decision.reason : undefined,
    }).catch((error) => {
      this.logger.error(`Failed to respond to permission ${approvalId}: ${extractErrorMessage(error)}`)
    })
  }

  getDescriptorPatch(): {
    currentModelId: string
    currentModeId: string
  } {
    return {
      currentModelId: this.currentModelId,
      currentModeId: this.currentModeId,
    }
  }
}

export async function listOpencodeDescriptorModels(cwd: string, currentModelId: string): Promise<{ models: Array<{ id: string; name: string; description?: string }>; currentModelId: string }> {
  ensureOpencodeInPath()
  const clientManager = OpencodeClientManager.getInstance({
    autoStartServer: true,
    cwd,
  })
  const client = await clientManager.getClient()
  const result = await (client as unknown as { provider: { list: () => Promise<ProviderListResponse> } }).provider.list()
  const allProviders = result.data?.all ?? []
  const connected = new Set(result.data?.connected ?? [])
  const models: Array<{ id: string; name: string; description?: string }> = []
  const aliases = new Map<string, string>()
  const seenModelIds = new Set<string>()

  const rememberAlias = (alias: string, fullModelId: string): void => {
    const normalizedAlias = alias.trim()
    if (!normalizedAlias) return
    aliases.set(normalizedAlias, fullModelId)
    const slashIndex = normalizedAlias.indexOf('/')
    if (slashIndex > 0 && slashIndex < normalizedAlias.length - 1) {
      aliases.set(normalizedAlias.slice(slashIndex + 1), fullModelId)
    }
  }

  for (const provider of allProviders) {
    if (!connected.has(provider.id)) continue
    for (const [modelKey, model] of Object.entries(provider.models ?? {})) {
      const rawModelId = model.id?.trim() || modelKey.trim()
      if (!rawModelId) continue
      const qualifiedId = rawModelId.includes('/') ? rawModelId : `${provider.id}/${rawModelId}`
      if (seenModelIds.has(qualifiedId)) continue
      seenModelIds.add(qualifiedId)
      models.push({
        id: qualifiedId,
        name: model.name?.trim() || rawModelId,
        description: `${provider.name} - ${model.status ?? ''}`.trim(),
      })
      rememberAlias(qualifiedId, qualifiedId)
      rememberAlias(rawModelId, qualifiedId)
      rememberAlias(modelKey, qualifiedId)
    }
  }

  if (models.length === 0) {
    return { models: [], currentModelId }
  }

  const normalizedCurrent = aliases.get(currentModelId.trim()) ?? (
    models.some((model) => model.id === currentModelId) ? currentModelId : models[0].id
  )
  return { models, currentModelId: normalizedCurrent }
}
