import { randomUUID } from 'node:crypto'
import { getRuntimeHost } from '../../host.js'
import type {
  DynamicSetApplied,
  DynamicSetPayload,
  Model,
  PermissionDecision,
  ProviderDescriptor,
  RuntimeMcpServers,
  RuntimeSession,
  RuntimeSessionParams,
  RuntimeStreamParams,
} from '../../types.js'
import { readStreamAsAsyncIterable } from '../../utils/read-stream.js'
import { createRuntimeLogger } from '../../logger.js'
import { buildRuntimeEnv } from '../../runtime-env.js'
import {
  buildDeveloperInstructions,
  CODEX_PLAN_MODE_ID,
  type CodexModeId,
  DEFAULT_THREAD_MODE,
  mapApprovalMode,
  mapReasoningEffort,
  mapSandboxMode,
  materializeCollaborationMode,
  REASONING_EFFORT_MAP,
  resolveCodexModeConfig,
  resolveCodexModeId,
  toSandboxPolicy,
} from './config.js'
import {
  buildThinkingLevelsFromModelInfo,
  getDefaultThinkingLevelFromModelInfo,
  mapModelInfoToDescriptor,
} from './model-info.js'
import { cleanupTempFiles, convertPrompt, isCompactCommand } from './message-mapper.js'
import { NotificationRouter } from './notification-router.js'
import { listModels } from './sdk/discovery.js'
import { AppServerClient } from './sdk/app-server-client.js'
import { SessionImpl } from './sdk/session.js'
import { buildConfigOverrides, resolveSdkMcpServers, stopSdkMcpServers } from './sdk/converters/settings-merger.js'
import type {
  CodexAppServerSettings,
  CommandApprovalHandler,
  CommandApprovalRequestParams,
  FileChangeApprovalHandler,
  FileChangeApprovalRequestParams,
  McpServerConfig as CodexSdkMcpServerConfig,
  ServiceTier as CodexServiceTier,
  ToolRequestUserInputHandler,
} from './sdk/types/settings.js'
import type {
  CodexGoal,
  CollaborationMode,
  GoalClearedParams,
  GoalUpdatedParams,
  ToolRequestUserInputParams,
  TurnError,
  TurnStartParams,
} from './sdk/protocol/messages.js'
import { GOAL_CONTINUE_DELAY_MS, goalStatusToFinishReason } from './goal-status.js'
import type { SdkMcpServer } from './sdk/tools/sdk-mcp-server.js'
import { CodexTextStreamEmitter } from './text-stream-emitter.js'
import { createResponseForDecision, type ApprovalResolverType } from './approval-response.js'
import { withLocalMcpNoProxy } from './local-mcp-env.js'
import { UNMEASURED_STEP_PERFORMANCE } from '../../stream-utils.js'

type ApprovalPayload =
  | import('./sdk/protocol/messages.js').CommandExecutionRequestApprovalResponse
  | import('./sdk/protocol/messages.js').FileChangeRequestApprovalResponse
  | import('./sdk/protocol/messages.js').ToolRequestUserInputResponse

type ApprovalResolver = {
  resolve: (response: ApprovalPayload) => void
  reject: (error: Error) => void
  type: ApprovalResolverType
}

type CodexMcpAuthStatus = 'unsupported' | 'notLoggedIn' | 'bearerToken' | 'oAuth'
type CodexMcpStartupState = 'starting' | 'ready' | 'failed' | 'cancelled'

interface CodexMcpServerStatus {
  name: string
  serverInfo: unknown | null
  tools: Record<string, unknown>
  authStatus: CodexMcpAuthStatus
}

interface CodexMcpServerStatusPage {
  data: CodexMcpServerStatus[]
  nextCursor: string | null
}

interface CodexMcpStartupStatus {
  threadId: string | null
  name: string
  status: CodexMcpStartupState
  error: string | null
  failureReason: 'reauthenticationRequired' | null
}

type SessionMcpStatus =
  | 'pending'
  | 'connected'
  | 'failed'
  | 'disabled'
  | 'needs-auth'
  | 'cancelled'

function isCodexMcpStartupState(value: unknown): value is CodexMcpStartupState {
  return value === 'starting' || value === 'ready' || value === 'failed' || value === 'cancelled'
}

/**
 * Session-only fallback when no modelId is provided and discovery has not run.
 * Not a picker default — live list + CLI `isDefault` come from listModels().
 */
export const DEFAULT_CODEX_MODEL_ID = 'gpt-5.6-sol'

export interface CodexModelState {
  models: Model[]
  thinkingLevels: NonNullable<ProviderDescriptor['thinkingLevels']>
  currentModelId: string
  currentThinkingLevel?: string
  hasLoaded: boolean
  refreshInFlight: Promise<void> | null
}

export function toCodexMcpServers(
  mcpServers?: RuntimeMcpServers,
): Record<string, CodexSdkMcpServerConfig> | undefined {
  if (!mcpServers || Object.keys(mcpServers).length === 0) return undefined
  const result: Record<string, CodexSdkMcpServerConfig> = {}
  for (const [name, entry] of Object.entries(mcpServers)) {
    if (!entry.type || entry.type === 'stdio') {
      result[name] = {
        transport: 'stdio',
        command: entry.command,
        args: entry.args,
        env: entry.env,
      } as CodexSdkMcpServerConfig
    } else {
      const httpEntry = entry as { url: string; headers?: Record<string, string> }
      result[name] = {
        transport: 'http',
        url: httpEntry.url,
        httpHeaders: httpEntry.headers,
      } as CodexSdkMcpServerConfig
    }
  }
  return result
}

export class CodexRuntimeSession implements RuntimeSession {
  private readonly logger = createRuntimeLogger('codex-runtime')
  private client: AppServerClient | null = null
  private currentModelId: string
  private currentModeId: CodexModeId
  private currentThinkingLevel = 'high'
  private currentServiceTier: CodexServiceTier | undefined
  private cwd: string
  private readonly env: Record<string, string>
  private threadId: string | undefined
  private codexSession: SessionImpl | null = null
  private activeRouter: NotificationRouter | null = null
  private abortController: AbortController | null = null
  private pendingApprovals = new Map<
    string,
    ApprovalResolver
  >()
  private activeSdkServers: SdkMcpServer[] = []
  private readonly mcpStartupStatuses = new Map<string, CodexMcpStartupStatus>()
  private readonly codexMcpServers: Record<string, CodexSdkMcpServerConfig> | undefined
  /** Session instructions (persona) from the host — folded into developerInstructions at thread creation. */
  private readonly instructions: string | undefined
  /** Latest known thread goal, mirrored from goal RPC responses + notifications. */
  private currentGoal: CodexGoal | null = null

  constructor(params: RuntimeSessionParams) {
    this.currentModelId = params.modelId ?? DEFAULT_CODEX_MODEL_ID
    this.currentModeId = resolveCodexModeId(params.modeId)
    if (params.thinkingLevel) this.currentThinkingLevel = params.thinkingLevel
    this.cwd = params.cwd
    this.env = withLocalMcpNoProxy(buildRuntimeEnv(params.env))
    this.currentServiceTier = params.serviceTier
    this.threadId = params.sessionId
    this.codexMcpServers = toCodexMcpServers(params.mcpServers)
    this.instructions = params.instructions?.trim() || undefined
  }

  private buildMemoryInstructions(): string | undefined {
    return undefined
  }

  private buildSettings(): CodexAppServerSettings {
    const memoryInstructions = this.buildMemoryInstructions()
    const codexMcp = this.codexMcpServers
    const codexPath = getRuntimeHost().resolveCliPath('codex')
    if (!codexPath) {
      throw new Error('Codex CLI not configured')
    }

    const modeConfig = resolveCodexModeConfig(this.currentModeId)

    return {
      codexPath,
      env: this.env,
      cwd: this.cwd,
      threadMode: DEFAULT_THREAD_MODE,
      approvalMode: modeConfig.approvalMode,
      approvalsReviewer: modeConfig.approvalsReviewer,
      sandboxMode: modeConfig.sandboxMode,
      defaultPermissions: modeConfig.defaultPermissions,
      ...(memoryInstructions ? { baseInstructions: memoryInstructions } : {}),
      ...(codexMcp ? { mcpServers: codexMcp } : {}),
      ...(this.currentServiceTier ? { serviceTier: this.currentServiceTier } : {}),
      reasoningEffort: REASONING_EFFORT_MAP[this.currentThinkingLevel] ?? 'high',
      resume: this.threadId,
      verbose: !!process.env.OPERON_VERBOSE,
      logger: this.logger,
      ...(this.getCollaborationMode()
        ? { collaborationMode: this.getCollaborationMode() }
        : {}),
      onCommandApproval: ((params: CommandApprovalRequestParams) =>
        new Promise((resolve, reject) => {
          this.pendingApprovals.set(params.itemId, {
            resolve: resolve as (response: ApprovalPayload) => void,
            reject,
            type: 'command',
          })
        })) as CommandApprovalHandler,
      onFileChangeApproval: ((params: FileChangeApprovalRequestParams) =>
        new Promise((resolve, reject) => {
          this.pendingApprovals.set(params.itemId, {
            resolve: resolve as (response: ApprovalPayload) => void,
            reject,
            type: 'fileChange',
          })
        })) as FileChangeApprovalHandler,
      onToolRequestUserInput: ((params: ToolRequestUserInputParams) =>
        new Promise((resolve, reject) => {
          this.pendingApprovals.set(params.itemId, {
            resolve: resolve as (response: ApprovalPayload) => void,
            reject,
            type: 'userInput',
          })
        })) as ToolRequestUserInputHandler,
    }
  }

  private getCollaborationMode(): CollaborationMode | undefined {
    if (this.currentModeId !== CODEX_PLAN_MODE_ID) return undefined
    return {
      mode: 'plan',
      settings: {
        model: this.currentModelId,
        reasoning_effort: null,
        developer_instructions: null,
      },
    }
  }

  private getClient(): AppServerClient {
    if (!this.client) {
      const settings = this.buildSettings()
      this.client = new AppServerClient(settings)
      // Codex proprietary: MCP tool calls are gated by an elicitation request
      // (codex_approval_kind: "mcp_tool_call"). Without a handler, codex gets
      // -32601 and fails the tool call. We auto-approve injected MCP servers
      // (memory / external_agent / workspace_chat / taskboard / im_chat / team_inbox)
      // since they're first-party;
      // other servers are user-configured and also auto-approved for now
      // because we don't have an approval UI for MCP tools yet.
      this.client.onRequest('mcpServer/elicitation/request', async (params) => {
        const p = params as { serverName?: string; _meta?: { codex_approval_kind?: string } }
        this.logger.debug(
          `Auto-accepting MCP elicitation from ${p.serverName} (${p._meta?.codex_approval_kind})`,
        )
        return { action: 'accept', content: {}, _meta: null }
      })

      // Session-level goal mirror: keep currentGoal fresh across turns/streams so
      // the loop's continuation decision and the GET endpoint see the latest state.
      this.client.onNotification('thread/goal/updated', (params) => {
        const p = params as GoalUpdatedParams
        if (this.threadId && String(p.threadId) !== String(this.threadId)) return
        this.currentGoal = p.goal
      })
      this.client.onNotification('thread/goal/cleared', (params) => {
        const p = params as GoalClearedParams
        if (this.threadId && String(p.threadId) !== String(this.threadId)) return
        this.currentGoal = null
      })
      this.client.onNotification('mcpServer/startupStatus/updated', (params) => {
        const value = params as Partial<CodexMcpStartupStatus>
        if (
          typeof value.name !== 'string' ||
          !isCodexMcpStartupState(value.status) ||
          (value.threadId !== null && typeof value.threadId !== 'string')
        ) {
          return
        }
        if (this.threadId && value.threadId && value.threadId !== this.threadId) return
        this.mcpStartupStatuses.set(value.name, {
          threadId: value.threadId,
          name: value.name,
          status: value.status,
          error: typeof value.error === 'string' ? value.error : null,
          failureReason:
            value.failureReason === 'reauthenticationRequired'
              ? 'reauthenticationRequired'
              : null,
        })
      })
    }
    return this.client
  }

  private getMcpDisplayStatus(server: CodexMcpServerStatus): {
    status: SessionMcpStatus
    error?: string
  } {
    const startup = this.mcpStartupStatuses.get(server.name)
    if (startup?.failureReason === 'reauthenticationRequired') {
      return {
        status: 'needs-auth',
        ...(startup.error ? { error: startup.error } : {}),
      }
    }
    if (startup) {
      const status: SessionMcpStatus =
        startup.status === 'starting'
          ? 'pending'
          : startup.status === 'ready'
            ? 'connected'
            : startup.status
      return {
        status,
        ...(startup.error ? { error: startup.error } : {}),
      }
    }
    if (server.authStatus === 'notLoggedIn') return { status: 'needs-auth' }
    if (server.serverInfo !== null || Object.keys(server.tools).length > 0) {
      return { status: 'connected' }
    }
    return { status: 'pending' }
  }

  private async listMcpServers(): Promise<{
    servers: Array<{
      name: string
      status: SessionMcpStatus
      transport?: 'stdio' | 'http'
      error?: string
      toolCount: number
    }>
  }> {
    const client = this.getClient()
    const servers: CodexMcpServerStatus[] = []
    let cursor: string | null = null

    do {
      const page: CodexMcpServerStatusPage = await client.request<CodexMcpServerStatusPage>(
        'mcpServerStatus/list',
        {
          cursor,
          limit: 100,
          detail: 'toolsAndAuthOnly',
          threadId: this.threadId ?? null,
        },
      )
      servers.push(...page.data)
      cursor = page.nextCursor
    } while (cursor)

    return {
      servers: servers.map((server) => {
        const display = this.getMcpDisplayStatus(server)
        const transport = this.codexMcpServers?.[server.name]?.transport
        return {
          name: server.name,
          status: display.status,
          ...(transport === 'stdio' || transport === 'http' ? { transport } : {}),
          ...(display.error ? { error: display.error } : {}),
          toolCount: Object.keys(server.tools).length,
        }
      }),
    }
  }

  private interruptTrackedSubTurns(): void {
    const client = this.client
    const router = this.activeRouter
    if (!client || !router) return

    for (const { threadId, turnId } of router.getActiveSubTurns()) {
      this.logger.info(`Interrupting sub-agent turn ${turnId} on thread ${threadId}`)
      void client.interruptTurn({ threadId, turnId }).catch((error) => {
        this.logger.warn(
          `Failed to interrupt sub-agent turn ${turnId} on thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    }
  }

  private createAbortSignal(externalSignal?: AbortSignal): AbortSignal {
    this.abortController = new AbortController()
    return externalSignal
      ? AbortSignal.any([externalSignal, this.abortController.signal])
      : this.abortController.signal
  }

  private async runCompactCommand(client: AppServerClient): Promise<ReadableStream<import('../../types.js').RuntimeTextStreamPart>> {
    const threadId = this.threadId
    const modelId = this.currentModelId
    return new ReadableStream({
      start: async (controller) => {
        const textId = randomUUID()
        controller.enqueue({ type: 'start' })
        controller.enqueue({ type: 'start-step', request: { body: { command: '/compact' } }, warnings: [] })
        controller.enqueue({ type: 'text-start', id: textId })

        if (!threadId) {
          controller.enqueue({ type: 'text-delta', id: textId, text: 'No active session to compact.' })
        } else {
          controller.enqueue({ type: 'text-delta', id: textId, text: 'Compacting conversation history...\n' })
          try {
            await client.request('thread/compact/start', { threadId })
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(() => {
                unsubscribe()
                reject(new Error('Compact timeout'))
              }, 120000)
              const unsubscribe = client.onNotification('turn/completed', (params: unknown) => {
                const payload = params as { threadId?: string }
                if (String(payload.threadId) !== String(threadId)) return
                clearTimeout(timeout)
                unsubscribe()
                resolve()
              })
            })
            controller.enqueue({ type: 'text-delta', id: textId, text: 'Compaction completed.' })
          } catch (error) {
            controller.enqueue({ type: 'text-delta', id: textId, text: `Compaction failed: ${String(error)}` })
          }
        }

        controller.enqueue({ type: 'text-end', id: textId })
        const usage = {
          inputTokens: 0,
          inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokens: 0,
          outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
          totalTokens: 0,
          raw: undefined,
        }
        controller.enqueue({
          type: 'finish-step',
          response: { id: randomUUID(), timestamp: new Date(), modelId },
          usage,
          performance: UNMEASURED_STEP_PERFORMANCE,
          finishReason: 'stop',
          rawFinishReason: 'stop',
          providerMetadata: threadId ? { codex: { sessionId: threadId } } : undefined,
        })
        controller.enqueue({
          type: 'finish',
          finishReason: 'stop',
          rawFinishReason: 'stop',
          totalUsage: usage,
        })
        controller.close()
      },
    })
  }

  /**
   * Resolve the thread id to operate on: start stateless, resume, reuse, or
   * start a new persistent thread. Shared by the normal turn path and the goal
   * pursuit loop.
   */
  private async resolveThreadId(
    client: AppServerClient,
    effectiveSettings: CodexAppServerSettings,
    instructions: string | undefined,
    threadMode: string,
  ): Promise<string> {
    if (threadMode === 'stateless') {
      this.logger.info('Starting stateless thread')
      const threadResult = await client.startThread({
        model: this.currentModelId,
        serviceTier: effectiveSettings.serviceTier,
        cwd: effectiveSettings.cwd,
        approvalPolicy: mapApprovalMode(effectiveSettings.approvalMode),
        approvalsReviewer: effectiveSettings.approvalsReviewer,
        sandbox: mapSandboxMode(effectiveSettings.sandboxMode),
        developerInstructions: buildDeveloperInstructions(effectiveSettings, instructions),
        config: buildConfigOverrides(effectiveSettings),
      })
      return threadResult.thread.id
    }
    if (effectiveSettings.resume) {
      this.logger.info(`Resuming thread ${effectiveSettings.resume}`)
      const resumeResult = await client.resumeThread({
        threadId: effectiveSettings.resume,
        model: this.currentModelId,
        serviceTier: effectiveSettings.serviceTier,
        cwd: effectiveSettings.cwd,
        approvalPolicy: mapApprovalMode(effectiveSettings.approvalMode),
        approvalsReviewer: effectiveSettings.approvalsReviewer,
        sandbox: mapSandboxMode(effectiveSettings.sandboxMode),
        config: buildConfigOverrides(effectiveSettings),
      })
      return resumeResult.thread.id
    }
    if (this.threadId) {
      this.logger.info(`Reusing thread ${this.threadId}`)
      return this.threadId
    }
    this.logger.info('Starting persistent thread')
    const threadResult = await client.startThread({
      model: this.currentModelId,
      serviceTier: effectiveSettings.serviceTier,
      cwd: effectiveSettings.cwd,
      approvalPolicy: mapApprovalMode(effectiveSettings.approvalMode),
      approvalsReviewer: effectiveSettings.approvalsReviewer,
      sandbox: mapSandboxMode(effectiveSettings.sandboxMode),
      developerInstructions: buildDeveloperInstructions(effectiveSettings, instructions),
      config: buildConfigOverrides(effectiveSettings),
    })
    return threadResult.thread.id
  }

  async *stream(params: RuntimeStreamParams) {
    const client = this.getClient()
    this.logger.info(`Starting stream with model ${this.currentModelId} in mode ${this.currentModeId}`)
    if (params.asGoal) {
      this.logger.info('Running goal pursuit loop')
      yield* this.streamGoalLoop(params)
      return
    }
    if (isCompactCommand(params.messages)) {
      this.logger.info('Running compact command')
      const compactStream = await this.runCompactCommand(client)
      for await (const part of readStreamAsAsyncIterable(compactStream)) {
        yield part
      }
      return
    }

    const settings = this.buildSettings()
    const threadMode = settings.threadMode ?? DEFAULT_THREAD_MODE
    const { resolved: resolvedMcpServers, sdkServers } = await resolveSdkMcpServers(settings.mcpServers)
    this.activeSdkServers = [...this.activeSdkServers.filter((server) => !sdkServers.includes(server)), ...sdkServers]
    const effectiveSettings: CodexAppServerSettings = {
      ...settings,
      mcpServers: resolvedMcpServers as Record<string, CodexSdkMcpServerConfig>,
    }

    const { inputs, warnings, tempFiles } = convertPrompt(params.messages, threadMode)
    const willReuseThread = threadMode !== 'stateless' && !!(effectiveSettings.resume || this.threadId)
    if (willReuseThread && this.instructions) {
      warnings.push({ type: 'other', message: 'Session instructions are ignored when reusing an existing thread.' })
    }

    let threadId = ''
    let turnId = ''
    let session: SessionImpl

    try {
      threadId = await this.resolveThreadId(client, effectiveSettings, this.instructions, threadMode)

      session = new SessionImpl(client, threadId)
      this.codexSession = session
      this.threadId = threadId

      const turnParams: TurnStartParams = {
        threadId,
        input: inputs,
        cwd: effectiveSettings.cwd,
        approvalPolicy: mapApprovalMode(effectiveSettings.approvalMode),
        approvalsReviewer: effectiveSettings.approvalsReviewer,
        sandboxPolicy: toSandboxPolicy(mapSandboxMode(effectiveSettings.sandboxMode)),
        model: this.currentModelId,
        serviceTier: effectiveSettings.serviceTier,
      }

      const effort = mapReasoningEffort(effectiveSettings.reasoningEffort)
      if (effort) turnParams.effort = effort
      const collaborationMode = materializeCollaborationMode(this.getCollaborationMode(), {
        model: this.currentModelId,
        reasoningEffort: effort ?? null,
        developerInstructions: buildDeveloperInstructions(effectiveSettings, this.instructions) ?? null,
      })
      if (collaborationMode) {
        turnParams.collaborationMode = collaborationMode
      }

      const turnResult = await client.startTurn(turnParams)
      turnId = String(turnResult.turn.id)
      this.logger.info(`Started turn ${turnId} on thread ${threadId}`)
      session._setTurnId(turnId)
    } catch (error) {
      cleanupTempFiles(tempFiles)
      throw error
    }

    const abortSignal = this.createAbortSignal(params.signal)
    const stream = new ReadableStream<import('../../types.js').RuntimeStreamPart>({
      start: (controller) => {
        controller.enqueue({ type: 'start' })
        controller.enqueue({
          type: 'start-step',
          request: { body: { threadId, input: inputs, cwd: effectiveSettings.cwd } },
          warnings,
        })

        const emitter = new CodexTextStreamEmitter(controller, {
          threadId,
          turnId,
          modelId: this.currentModelId,
        })

        const cleanup = () => {
          cleanupTempFiles(tempFiles)
          if (threadMode === 'stateless') {
            this.codexSession = null
          }
        }

        let finalized = false
        let router: NotificationRouter | undefined
        const finalize = (status?: string, error?: { code?: string; message?: string } | null) => {
          if (finalized) return
          finalized = true
          session._setInactive()
          if (status !== undefined || error !== undefined) {
            emitter.emitFinish(status, error)
          }
          router?.unsubscribe()
          if (this.activeRouter === router) {
            this.activeRouter = null
          }
          emitter.close()
          cleanup()
        }

        router = new NotificationRouter(client, emitter, {
          threadId,
          turnId,
          onTurnCompleted: (status, error) => finalize(status, error),
          onCommandApproval: effectiveSettings.onCommandApproval,
          onFileChangeApproval: effectiveSettings.onFileChangeApproval,
          onToolRequestUserInput: effectiveSettings.onToolRequestUserInput,
        })
        this.activeRouter = router
        router.subscribe()

        abortSignal.addEventListener(
          'abort',
          async () => {
            try {
              await session.interrupt()
            } catch {
              // ignore
            }
            finalize()
          },
          { once: true },
        )
      },
      cancel: async () => {
        try {
          await session.interrupt()
        } catch {
          // ignore
        }
      },
    })

    try {
      for await (const part of readStreamAsAsyncIterable(stream)) {
        yield part
      }
    } finally {
      if (threadMode === 'stateless') {
        this.codexSession = null
      }
    }
  }

  /**
   * Goal pursuit loop. Mirrors Codex desktop's worker behaviour: each
   * `goal/set {active}` runs exactly one codex-initiated turn; when the thread
   * goes idle and the goal is still active, we re-issue `goal/set {active}`
   * (debounced) to continue, until the goal reaches a non-active status.
   *
   * The live SSE connection acts as the ownership lease — on abort/disconnect
   * we pause the goal (and interrupt the active turn), exactly like codex's
   * "owner became unavailable → pause".
   */
  private async *streamGoalLoop(params: RuntimeStreamParams) {
    const client = this.getClient()
    const settings = this.buildSettings()
    const threadMode = settings.threadMode ?? DEFAULT_THREAD_MODE
    const { resolved: resolvedMcpServers, sdkServers } = await resolveSdkMcpServers(settings.mcpServers)
    this.activeSdkServers = [...this.activeSdkServers.filter((server) => !sdkServers.includes(server)), ...sdkServers]
    const effectiveSettings: CodexAppServerSettings = {
      ...settings,
      mcpServers: resolvedMcpServers as Record<string, CodexSdkMcpServerConfig>,
    }

    const { inputs, warnings, tempFiles } = convertPrompt(params.messages, threadMode)
    const objective = inputs
      .filter((input): input is { type: 'text'; text: string } => input.type === 'text')
      .map((input) => input.text)
      .join('\n')
      .trim()

    let threadId: string
    try {
      threadId = await this.resolveThreadId(client, effectiveSettings, this.instructions, threadMode)
      this.threadId = threadId
    } catch (error) {
      cleanupTempFiles(tempFiles)
      throw error
    }

    const abortSignal = this.createAbortSignal(params.signal)
    const MAX_GOAL_ITERATIONS = 50

    const stream = new ReadableStream<import('../../types.js').RuntimeStreamPart>({
      start: (controller) => {
        controller.enqueue({ type: 'start' })
        controller.enqueue({
          type: 'start-step',
          request: { body: { threadId, goalObjective: objective } },
          warnings,
        })

        const emitter = new CodexTextStreamEmitter(controller, {
          threadId,
          turnId: '',
          modelId: this.currentModelId,
        })

        // Stream live goal progress (timeUsedSeconds / tokensUsed / status) to the
        // client as message metadata for the whole pursuit, not just turn edges.
        const goalUpdateUnsub = client.onNotification('thread/goal/updated', (paramsRaw) => {
          const p = paramsRaw as GoalUpdatedParams
          if (String(p.threadId) !== String(threadId)) return
          this.currentGoal = p.goal
          emitter.emitGoalUpdate(p.goal)
        })

        let finalized = false
        let stopped = false
        let activeRouter: NotificationRouter | undefined

        const finalize = (status?: string, error?: TurnError | null) => {
          if (finalized) return
          finalized = true
          stopped = true
          goalUpdateUnsub()
          activeRouter?.unsubscribe()
          if (this.activeRouter === activeRouter) this.activeRouter = null
          this.codexSession?._setInactive()
          emitter.emitFinish(status ?? 'stop', error ?? null)
          emitter.close()
          cleanupTempFiles(tempFiles)
        }

        const runLoop = async () => {
          try {
            for (let iteration = 0; iteration < MAX_GOAL_ITERATIONS; iteration++) {
              if (stopped || abortSignal.aborted) break

              const turnStartedPromise = this.waitForGoalTurnStarted(client, threadId, abortSignal)

              let goal: CodexGoal
              try {
                const result = await client.setGoal({
                  threadId,
                  objective: iteration === 0 ? objective : undefined,
                  status: 'active',
                })
                goal = result.goal
              } catch (error) {
                finalize('error', { message: error instanceof Error ? error.message : String(error) })
                return
              }
              this.currentGoal = goal
              emitter.emitGoalUpdate(goal)

              if (goal.status !== 'active') {
                // Goal already resolved / not runnable — nothing to stream.
                finalize(goalStatusToFinishReason(goal.status))
                return
              }

              const turnId = await turnStartedPromise
              if (stopped || abortSignal.aborted) {
                finalize()
                return
              }
              if (!turnId) {
                // codex did not start a turn (objective already satisfied / timeout)
                finalize(goalStatusToFinishReason(this.currentGoal?.status))
                return
              }

              this.codexSession = new SessionImpl(client, threadId)
              this.codexSession._setTurnId(turnId)

              const outcome = await this.runGoalTurn(
                client,
                emitter,
                effectiveSettings,
                threadId,
                turnId,
                (router) => {
                  activeRouter = router
                  this.activeRouter = router
                },
              )

              activeRouter?.unsubscribe()
              if (this.activeRouter === activeRouter) this.activeRouter = null
              activeRouter = undefined
              this.codexSession?._setInactive()

              // Close any open text/reasoning blocks so the next turn renders cleanly.
              emitter.flushText()
              emitter.flushReasoning()

              if (stopped || abortSignal.aborted) {
                finalize()
                return
              }

              const turnStatus = String(outcome.status).toLowerCase()
              if (turnStatus === 'failed') {
                finalize('error', outcome.error)
                return
              }

              // Re-read the authoritative goal status before deciding to continue.
              try {
                const { goal: latest } = await client.getGoal({ threadId })
                this.currentGoal = latest
                emitter.emitGoalUpdate(latest)
              } catch {
                // keep last-known currentGoal
              }

              if (this.currentGoal?.status !== 'active') {
                finalize(goalStatusToFinishReason(this.currentGoal?.status))
                return
              }

              await this.delay(GOAL_CONTINUE_DELAY_MS, abortSignal)
            }
            finalize()
          } catch (error) {
            finalize('error', { message: error instanceof Error ? error.message : String(error) })
          }
        }

        void runLoop()

        abortSignal.addEventListener(
          'abort',
          () => {
            void this.pauseActiveGoal(client, threadId)
            finalize()
          },
          { once: true },
        )
      },
      cancel: () => {
        // Consumer (SSE) went away — route through abort so the goal is paused.
        this.abort()
      },
    })

    try {
      for await (const part of readStreamAsAsyncIterable(stream)) {
        yield part
      }
    } finally {
      if (threadMode === 'stateless') {
        this.codexSession = null
      }
    }
  }

  /**
   * Wait for the turn codex auto-starts after `goal/set {active}` and return its
   * id. Resolves null on timeout/abort. Sub-agent turns (different threadId) are
   * ignored.
   */
  private waitForGoalTurnStarted(
    client: AppServerClient,
    threadId: string,
    signal: AbortSignal,
    timeoutMs = 60_000,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false
      let unsubscribe = () => {}
      const timer = setTimeout(() => finish(null), timeoutMs)
      const onAbort = () => finish(null)
      const finish = (value: string | null) => {
        if (settled) return
        settled = true
        unsubscribe()
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      unsubscribe = client.onNotification('turn/started', (paramsRaw) => {
        const payload = paramsRaw as { threadId: string; turn: { id: string } }
        if (String(payload.threadId) !== String(threadId)) return
        finish(String(payload.turn.id))
      })
      if (signal.aborted) finish(null)
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Run a single (already-started) goal turn through a fresh NotificationRouter
   * that shares the loop's emitter, resolving when the turn completes.
   */
  private runGoalTurn(
    client: AppServerClient,
    emitter: CodexTextStreamEmitter,
    effectiveSettings: CodexAppServerSettings,
    threadId: string,
    turnId: string,
    onRouter: (router: NotificationRouter) => void,
  ): Promise<{ status: string; error?: TurnError | null }> {
    return new Promise((resolve) => {
      let done = false
      const router = new NotificationRouter(client, emitter, {
        threadId,
        turnId,
        onTurnCompleted: (status, error) => {
          if (done) return
          done = true
          resolve({ status, error })
        },
        onCommandApproval: effectiveSettings.onCommandApproval,
        onFileChangeApproval: effectiveSettings.onFileChangeApproval,
        onToolRequestUserInput: effectiveSettings.onToolRequestUserInput,
      })
      onRouter(router)
      router.subscribe()
    })
  }

  /** Pause the goal if it is still active (used on abort/disconnect). */
  private async pauseActiveGoal(client: AppServerClient, threadId: string): Promise<void> {
    try {
      if (this.currentGoal?.status === 'active') {
        const { goal } = await client.setGoal({ threadId, status: 'paused' })
        this.currentGoal = goal
      }
    } catch (error) {
      this.logger.warn(`Failed to pause goal on abort: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      await this.codexSession?.interrupt()
    } catch {
      // ignore
    }
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  abort(): void {
    this.logger.info('Abort requested')
    this.abortController?.abort()
    this.abortController = null
    this.codexSession?.interrupt().catch(() => {})
    this.interruptTrackedSubTurns()
  }

  async agentControl(method: string, _params: unknown): Promise<unknown> {
    if (method === 'mcp.list') return this.listMcpServers()
    throw new Error(`Unsupported Codex session control method: ${method}`)
  }

  async dispose(): Promise<void> {
    this.abort()
    this.activeRouter = null
    this.codexSession = null
    this.pendingApprovals.clear()
    this.mcpStartupStatuses.clear()
    this.currentGoal = null
    this.threadId = undefined
    this.client?.dispose()
    this.client = null
    await stopSdkMcpServers(this.activeSdkServers).catch(() => {})
    this.activeSdkServers = []
  }

  resolvePermission(approvalId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingApprovals.get(approvalId)
    if (!pending) return false
    this.pendingApprovals.delete(approvalId)
    pending.resolve(createResponseForDecision(pending.type, decision))
    return true
  }

  getSessionId(): string | undefined {
    return this.threadId
  }

  async injectMessage(content: string): Promise<void> {
    if (!this.codexSession) {
      throw new Error('[CodexRuntime] No active Codex session')
    }
    this.logger.info(`Injecting follow-up into thread ${this.threadId ?? 'unknown'}`)
    await this.codexSession.injectMessage(content)
  }

  async getGoal(): Promise<CodexGoal | null> {
    if (!this.threadId) return this.currentGoal
    try {
      const { goal } = await this.getClient().getGoal({ threadId: this.threadId })
      this.currentGoal = goal ?? null
    } catch (error) {
      this.logger.warn(`getGoal failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return this.currentGoal
  }

  async setGoalStatus(status: 'active' | 'paused'): Promise<CodexGoal | null> {
    if (!this.threadId) return this.currentGoal
    const { goal } = await this.getClient().setGoal({ threadId: this.threadId, status })
    this.currentGoal = goal ?? null
    return this.currentGoal
  }

  async clearGoal(): Promise<void> {
    this.currentGoal = null
    if (!this.threadId) return
    await this.getClient().clearGoal({ threadId: this.threadId })
  }

  /**
   * Store-only, and that is enough: a turn is one `startTurn` request, and its
   * params (`model` / `effort` / `serviceTier` / `approvalPolicy`) are rebuilt from
   * these fields on every turn — `buildSettings()` runs per stream, not once per
   * client. So the next turn picks the new values up on its own.
   *
   * Deliberately NOT paired with `features.dynamicSwitch`: a turn already in flight
   * cannot be re-parameterised, since its request went out when it started. This is
   * the between-turns path only, which is what spares the session a rebuild.
   */
  async dynamicSet(payload: DynamicSetPayload): Promise<DynamicSetApplied> {
    const applied: DynamicSetApplied = []
    if (payload.modelId) {
      this.currentModelId = payload.modelId
      applied.push('modelId')
    }
    if (payload.modeId) {
      this.currentModeId = resolveCodexModeId(payload.modeId)
      applied.push('modeId')
    }
    if (payload.thinkingLevel) {
      this.currentThinkingLevel = payload.thinkingLevel
      applied.push('thinkingLevel')
    }
    return applied
  }

  getDescriptorPatch(): {
    currentModelId: string
    currentModeId: string
    currentThinkingLevel: string
    currentServiceTier: CodexServiceTier | undefined
  } {
    return {
      currentModelId: this.currentModelId,
      currentModeId: this.currentModeId,
      currentThinkingLevel: this.currentThinkingLevel,
      currentServiceTier: this.currentServiceTier,
    }
  }
}

export async function refreshCodexModels(modelState: CodexModelState): Promise<void> {
  const logger = createRuntimeLogger('codex-runtime')
  if (modelState.refreshInFlight) {
    await modelState.refreshInFlight
    return
  }
  if (modelState.hasLoaded) return

  const refresh = (async () => {
    let loaded = false
    try {
      const codexPath = getRuntimeHost().resolveCliPath('codex')
      if (!codexPath) return
      const { models, defaultModel } = await listModels({
        codexPath,
        env: buildRuntimeEnv(),
      })
      const normalized = models.map(mapModelInfoToDescriptor)
      // No static fallback table — only the live list (or empty if discovery fails).
      modelState.models = normalized
      if (normalized.length > 0) {
        modelState.thinkingLevels = buildThinkingLevelsFromModelInfo(models)
        // First successful discovery: take the CLI's default (e.g. gpt-5.6-sol),
        // not our hardcoded placeholder. Keep a prior selection only when it is
        // still in the live list and is not the placeholder id.
        const knownIds = new Set(normalized.map((m) => m.id))
        const keepCurrent =
          modelState.currentModelId !== DEFAULT_CODEX_MODEL_ID &&
          knownIds.has(modelState.currentModelId)
        modelState.currentModelId = keepCurrent
          ? modelState.currentModelId
          : defaultModel?.id ?? normalized[0]?.id ?? modelState.currentModelId
        modelState.currentThinkingLevel = getDefaultThinkingLevelFromModelInfo(defaultModel, models)
      }
      loaded = true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(`Failed to refresh models: ${message}`)
    } finally {
      modelState.refreshInFlight = null
      modelState.hasLoaded = loaded
    }
  })()

  modelState.refreshInFlight = refresh
  await refresh
}
