import { randomUUID } from 'node:crypto'
import {
  CompressionStatus,
  CoreToolScheduler,
  GeminiEventType,
  isSubagentProgress,
  tokenLimit,
  ToolConfirmationOutcome,
  type AnsiOutput,
  type ChatCompressionInfo,
  type CompletedToolCall,
  type Config,
  type GeminiClient as CoreGeminiClient,
  type ToolCallConfirmationDetails,
  type ToolCallRequestInfo,
  type ToolLiveOutput,
  type Turn,
  type WaitingToolCall,
} from '@google/gemini-cli-core'
import type { PartListUnion } from '@google/genai'
import type {
  PermissionDecision,
  RuntimeMcpServers,
  RuntimeSession,
  RuntimeSessionParams,
  RuntimeStreamParams,
  RuntimeStreamPart,
  RuntimeTextStreamPart,
} from '../../types.js'
import { initializeRuntime } from './config.js'
import { extractLatestUserParts, isCompactCommand, mapMessagesToGeminiFormat } from './message-mapper.js'
import { convertToHistory, loadSession } from './session-store.js'
import type { GeminiProviderOptions, GeminiRuntimeSettings } from './types.js'
import { createRuntimeLogger } from '../../logger.js'
import { MEMORY_RESOLVER_PROMPT, FILE_REFERENCE_PROMPT } from '../../memory-resolver-prompt.js'
import { logProviderRaw } from '../../provider-raw-log.js'
import { applyRuntimeEnv } from '../../runtime-env.js'
import { buildStreamMessageMetadata } from '../../stream-message-metadata.js'
import { UNMEASURED_STEP_PERFORMANCE } from '../../stream-utils.js'

const GEMINI_PROVIDER_OPTIONS: GeminiProviderOptions = {
  authType: 'oauth-personal',
}

const MODES_CONFIG: Record<string, string> = {
  Default: 'default',
  AutoEdit: 'autoEdit',
  FullAccess: 'yolo',
}

const FIXED_THINKING_LEVEL = 'high'

type GeminiProviderMetadata = Extract<RuntimeTextStreamPart, { type: 'finish-step' }>['providerMetadata']
type GeminiUsage = Extract<RuntimeTextStreamPart, { type: 'finish-step' }>['usage']
type GeminiRequestMetadata = Extract<RuntimeTextStreamPart, { type: 'start-step' }>['request']
type GeminiResponseMetadata = Extract<RuntimeTextStreamPart, { type: 'finish-step' }>['response']

type PendingApproval = {
  toolCallId: string
  onConfirm: (outcome: ToolConfirmationOutcome, payload?: Record<string, unknown>) => Promise<void>
}

interface JsonSchemaObject {
  [key: string]: JsonSchemaValue | undefined
}

type JsonSchemaValue = string | number | boolean | null | JsonSchemaObject | JsonSchemaValue[]

function buildUsage(inputTokens?: number, outputTokens?: number): GeminiUsage {
  return {
    inputTokens,
    inputTokenDetails: {
      noCacheTokens: inputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    outputTokens,
    outputTokenDetails: {
      textTokens: outputTokens,
      reasoningTokens: 0,
    },
    totalTokens:
      inputTokens !== undefined && outputTokens !== undefined
        ? inputTokens + outputTokens
        : inputTokens ?? outputTokens,
    raw: undefined,
  }
}

function toPlainText(chunk: string | AnsiOutput): string {
  if (typeof chunk === 'string') return chunk
  return chunk
    .map((line) => line.map((token) => token.text).join(''))
    .join('\n')
}

export class GeminiRuntimeSession implements RuntimeSession {
  private readonly logger = createRuntimeLogger('gemini-runtime')
  private coreConfig?: Config
  private geminiClient?: CoreGeminiClient
  private runtimeInitPromise?: Promise<void>
  private chatStarted = false
  private currentModelId: string
  private currentModeId: string
  private cwd: string
  private readonly env: Record<string, string | undefined> | undefined
  private sessionId: string | undefined
  private abortController: AbortController | null = null
  private lastCompactInfo: ChatCompressionInfo | null = null
  private pendingApprovals = new Map<string, PendingApproval>()
  private readonly mcpServers: RuntimeMcpServers | undefined
  /** Session instructions (persona) from the host — folded into userMemory at init. */
  private readonly instructions: string | undefined

  constructor(params: RuntimeSessionParams) {
    this.currentModelId = params.modelId ?? 'gemini-3-pro-preview'
    this.currentModeId = params.modeId ?? 'Default'
    this.cwd = params.cwd
    this.env = params.env
    this.sessionId = params.sessionId
    this.mcpServers = params.mcpServers
    this.instructions = params.instructions?.trim() || undefined
  }

  private buildThinkingConfig(modelId: string): GeminiRuntimeSettings['thinkingConfig'] | undefined {
    if (modelId.startsWith('gemini-2.5-')) {
      return { thinkingBudget: -1 }
    }
    return { thinkingLevel: FIXED_THINKING_LEVEL }
  }

  private buildRuntimeSettings(): GeminiRuntimeSettings {
    // Memory prompts + host session instructions flow through the runtime's
    // userMemory (applied via setUserMemory + updateSystemInstruction at init).
    const memoryParts = [MEMORY_RESOLVER_PROMPT, FILE_REFERENCE_PROMPT, this.instructions].filter(
      (s): s is string => !!s && s.trim().length > 0,
    )
    const userMemory: string | undefined = memoryParts.length > 0 ? memoryParts.join('\n\n') : undefined

    const mcpServers = this.mcpServers

    // Only trust built-in MCP servers, not user-configured ones
    const TRUSTED_MCP_NAMES = new Set([
      'workspace_chat',
      'taskboard',
      'im_chat',
      'team_inbox',
      'memory',
      'external_agent',
    ])
    const trustedMcpServers: Record<string, { trust: boolean }> = {}
    if (mcpServers) {
      for (const name of Object.keys(mcpServers)) {
        if (TRUSTED_MCP_NAMES.has(name)) {
          trustedMcpServers[name] = { trust: true }
        }
      }
    }

    return {
      cwd: this.cwd,
      interactive: true,
      modelSteering: true,
      approvalMode: MODES_CONFIG[this.currentModeId] ?? 'default',
      sessionId: this.sessionId,
      thinkingConfig: this.buildThinkingConfig(this.currentModelId),
      maxOutputTokens: 65536,
      mcpServers,
      userMemory,
      policySettings: {
        tools: { allowed: ['enter_plan_mode'] },
        mcpServers: trustedMcpServers,
      },
    }
  }

  private async initRuntime(): Promise<void> {
    this.logger.info(`Initializing runtime with model ${this.currentModelId} in mode ${this.currentModeId}`)
    applyRuntimeEnv(this.env)
    const settings = this.buildRuntimeSettings()
    const { config, sessionId } = await initializeRuntime(GEMINI_PROVIDER_OPTIONS, this.currentModelId, settings)
    this.coreConfig = config
    this.geminiClient = config.getGeminiClient()
    await this.geminiClient.initialize()
    this.sessionId = config.getSessionId() || sessionId
    this.logger.info(`Runtime initialized${this.sessionId ? ` with session ${this.sessionId}` : ''}`)

    if (settings.userMemory) {
      const existing = config.getUserMemory()
      const append = settings.userMemory
      if (typeof existing === 'string') {
        config.setUserMemory(existing ? `${existing}\n\n${append}` : append)
      } else {
        config.setUserMemory({
          ...existing,
          global: existing.global ? `${existing.global}\n\n${append}` : append,
        })
      }
      config.updateSystemInstructionIfInitialized()
    }

    if (settings.sessionId) {
      this.logger.info(`Resuming session ${settings.sessionId}`)
      const resumedData = await loadSession(config, settings.sessionId)
      const history = convertToHistory(resumedData.conversation)
      await this.geminiClient.resumeChat(history, resumedData)
      this.chatStarted = true
      const resumedSessionId =
        typeof resumedData.conversation.sessionId === 'string' &&
        resumedData.conversation.sessionId.trim().length > 0
          ? resumedData.conversation.sessionId
          : undefined
      if (resumedSessionId) {
        this.sessionId = resumedSessionId
      }
      this.logger.info(`Session resumed${this.sessionId ? ` as ${this.sessionId}` : ''}`)
    }
  }

  private async ensureRuntimeInitialized(): Promise<{
    config: Config
    geminiClient: CoreGeminiClient
  }> {
    if (this.coreConfig && this.geminiClient) {
      return { config: this.coreConfig, geminiClient: this.geminiClient }
    }

    if (!this.runtimeInitPromise) {
      this.runtimeInitPromise = this.initRuntime()
    }
    await this.runtimeInitPromise

    if (!this.coreConfig || !this.geminiClient) {
      throw new Error('Failed to initialize Gemini runtime')
    }
    return { config: this.coreConfig, geminiClient: this.geminiClient }
  }

  private createAbortSignal(externalSignal?: AbortSignal): AbortSignal {
    this.abortController = new AbortController()
    return externalSignal
      ? AbortSignal.any([externalSignal, this.abortController.signal])
      : this.abortController.signal
  }

  private getSessionProviderMetadata(contextTokens?: number): GeminiProviderMetadata {
    if (!this.sessionId) return undefined
    const metadata: JsonSchemaObject = { sessionId: this.sessionId }

    if (this.lastCompactInfo?.compressionStatus === CompressionStatus.COMPRESSED) {
      metadata.compacted = {
        originalTokenCount: this.lastCompactInfo.originalTokenCount,
        newTokenCount: this.lastCompactInfo.newTokenCount,
      }
      this.lastCompactInfo = null
    }

    if (contextTokens != null && contextTokens > 0) {
      const contextWindow = tokenLimit(this.currentModelId)
      const contextUsage: JsonSchemaObject = { promptTokens: contextTokens }
      if (contextWindow > 0) {
        contextUsage.contextWindow = contextWindow
        contextUsage.percentUsed = contextTokens / contextWindow
      }
      metadata.contextUsage = contextUsage
    }

    return { 'gemini-cli': metadata }
  }

  private makeResponseMetadata(): GeminiResponseMetadata {
    return {
      id: randomUUID(),
      timestamp: new Date(),
      modelId: this.currentModelId,
    }
  }

  private buildMessageMetadata(contextTokens: number, inputTokens: number, outputTokens: number) {
    return buildStreamMessageMetadata({
      providerMetadata: this.getSessionProviderMetadata(contextTokens),
      usage: buildUsage(inputTokens, outputTokens),
    })
  }

  private async runCompactCommand(geminiClient: CoreGeminiClient): Promise<RuntimeStreamPart[]> {
    this.logger.info('Running compact command')
    const textId = randomUUID()
    const parts: RuntimeStreamPart[] = [
      { type: 'start' },
      { type: 'start-step', request: { body: { command: '/compact' } }, warnings: [] },
      { type: 'text-start', id: textId },
      { type: 'text-delta', id: textId, text: 'Compacting conversation history...\n' },
    ]

    try {
      const info = await geminiClient.tryCompressChat('user-requested', true)
      if (info.compressionStatus === CompressionStatus.COMPRESSED) {
        parts.push({
          type: 'text-delta',
          id: textId,
          text: `Compaction completed: ${info.originalTokenCount} -> ${info.newTokenCount} tokens`,
        })
      } else {
        parts.push({
          type: 'text-delta',
          id: textId,
          text: 'No compaction needed.',
        })
      }
    } catch (error) {
      parts.push({
        type: 'text-delta',
        id: textId,
        text: `Compaction failed: ${String(error)}`,
      })
    }

    parts.push(
      { type: 'text-end', id: textId },
      {
        type: 'message-metadata',
        metadata: this.buildMessageMetadata(0, 0, 0),
      },
      {
        type: 'finish-step',
        response: this.makeResponseMetadata(),
        usage: buildUsage(0, 0),
        performance: UNMEASURED_STEP_PERFORMANCE,
        finishReason: 'stop',
        rawFinishReason: 'stop',
        providerMetadata: this.getSessionProviderMetadata(),
      },
      {
        type: 'finish',
        finishReason: 'stop',
        rawFinishReason: 'stop',
        totalUsage: buildUsage(0, 0),
      },
    )
    return parts
  }

  private async *runOneTurnStreaming(
    request: PartListUnion,
    promptId: string,
    signal: AbortSignal,
  ): AsyncGenerator<RuntimeTextStreamPart, {
    pendingToolCalls: ToolCallRequestInfo[]
    inputTokens: number
    outputTokens: number
    rawFinishReason: string | undefined
  }> {
    const geminiClient = this.geminiClient
    if (!geminiClient) {
      throw new Error('Gemini client not initialized')
    }

    let textPartId: string | undefined
    let reasoningPartId: string | undefined
    let inputTokens = 0
    let outputTokens = 0
    let rawFinishReason: string | undefined

    const generator = geminiClient.sendMessageStream(request, signal, promptId)
    const iterator = generator[Symbol.asyncIterator]()
    let turnResult: Turn | undefined

    while (true) {
      const { value, done } = await iterator.next()
      logProviderRaw('gemini', value)
      if (done) {
        turnResult = value as Turn
        break
      }

      switch (value.type) {
        case GeminiEventType.Content: {
          if (!textPartId) {
            textPartId = randomUUID()
            yield { type: 'text-start', id: textPartId }
          }
          yield {
            type: 'text-delta',
            id: textPartId,
            text: value.value as string,
          }
          break
        }
        case GeminiEventType.ToolCallRequest: {
          const requestInfo = value.value as ToolCallRequestInfo
          yield {
            type: 'tool-call',
            toolCallId: requestInfo.callId,
            toolName: requestInfo.name,
            input: requestInfo.args,
            providerExecuted: true,
            dynamic: true,
          }
          break
        }
        case GeminiEventType.Finished: {
          const finished = value.value as {
            reason?: string
            usageMetadata?: {
              promptTokenCount?: number
              candidatesTokenCount?: number
            }
          }
          inputTokens = finished.usageMetadata?.promptTokenCount ?? 0
          outputTokens = finished.usageMetadata?.candidatesTokenCount ?? 0
          rawFinishReason = finished.reason
          break
        }
        case GeminiEventType.Error: {
          const error = value.value as { error: { message: string } }
          throw new Error(error.error.message)
        }
        case GeminiEventType.ChatCompressed: {
          const compressInfo = value.value as ChatCompressionInfo | null
          if (compressInfo) {
            this.lastCompactInfo = compressInfo
          }
          break
        }
        case GeminiEventType.Thought: {
          const thought = value.value as { subject: string; description: string }
          const thoughtText = thought.subject
            ? `**${thought.subject}** ${thought.description}`
            : thought.description
          if (!reasoningPartId) {
            reasoningPartId = randomUUID()
            yield { type: 'reasoning-start', id: reasoningPartId }
          }
          yield {
            type: 'reasoning-delta',
            id: reasoningPartId,
            text: `${thoughtText}\n`,
          }
          break
        }
        case GeminiEventType.AgentExecutionStopped: {
          const stopped = value.value as {
            reason: string
            systemMessage?: string
            contextCleared?: boolean
          }
          if (textPartId) {
            yield { type: 'text-end', id: textPartId }
            textPartId = undefined
          }
          const stopId = randomUUID()
          yield { type: 'text-start', id: stopId }
          yield {
            type: 'text-delta',
            id: stopId,
            text: `\n\n---\n**Agent stopped:** ${stopped.reason}${stopped.systemMessage ? `\n${stopped.systemMessage}` : ''}${stopped.contextCleared ? '\n(Context was cleared)' : ''}\n`,
          }
          yield { type: 'text-end', id: stopId }
          break
        }
        case GeminiEventType.AgentExecutionBlocked: {
          const blocked = value.value as {
            reason: string
            systemMessage?: string
            contextCleared?: boolean
          }
          if (textPartId) {
            yield { type: 'text-end', id: textPartId }
            textPartId = undefined
          }
          const blockId = randomUUID()
          yield { type: 'text-start', id: blockId }
          yield {
            type: 'text-delta',
            id: blockId,
            text: `\n\n---\n**Agent blocked:** ${blocked.reason}${blocked.systemMessage ? `\n${blocked.systemMessage}` : ''}${blocked.contextCleared ? '\n(Context was cleared)' : ''}\n`,
          }
          yield { type: 'text-end', id: blockId }
          break
        }
        case GeminiEventType.ContextWindowWillOverflow: {
          const overflow = value.value as {
            estimatedRequestTokenCount: number
            remainingTokenCount: number
          }
          if (textPartId) {
            yield { type: 'text-end', id: textPartId }
            textPartId = undefined
          }
          const overflowId = randomUUID()
          yield { type: 'text-start', id: overflowId }
          yield {
            type: 'text-delta',
            id: overflowId,
            text: `\n\n> **Context window warning:** Estimated ${overflow.estimatedRequestTokenCount} tokens used, only ${overflow.remainingTokenCount} remaining. Consider starting a new conversation.\n`,
          }
          yield { type: 'text-end', id: overflowId }
          break
        }
        case GeminiEventType.LoopDetected: {
          if (textPartId) {
            yield { type: 'text-end', id: textPartId }
            textPartId = undefined
          }
          const loopId = randomUUID()
          yield { type: 'text-start', id: loopId }
          yield {
            type: 'text-delta',
            id: loopId,
            text: '\n\n> **Loop detected:** The model appears to be repeating actions. Intervention may be needed.\n',
          }
          yield { type: 'text-end', id: loopId }
          break
        }
        case GeminiEventType.MaxSessionTurns: {
          if (textPartId) {
            yield { type: 'text-end', id: textPartId }
            textPartId = undefined
          }
          const maxTurnsId = randomUUID()
          yield { type: 'text-start', id: maxTurnsId }
          yield {
            type: 'text-delta',
            id: maxTurnsId,
            text: '\n\n> **Session limit reached:** Maximum number of turns exceeded. Please start a new conversation.\n',
          }
          yield { type: 'text-end', id: maxTurnsId }
          break
        }
        case GeminiEventType.Citation: {
          if (textPartId) {
            yield {
              type: 'text-delta',
              id: textPartId,
              text: `\n${String(value.value)}`,
            }
          }
          break
        }
        default:
          break
      }
    }

    if (reasoningPartId) {
      yield { type: 'reasoning-end', id: reasoningPartId }
    }
    if (textPartId) {
      yield { type: 'text-end', id: textPartId }
    }

    return {
      pendingToolCalls: turnResult?.pendingToolCalls ?? [],
      inputTokens,
      outputTokens,
      rawFinishReason,
    }
  }

  private async *runToolBatchStreaming(
    pendingToolCalls: ToolCallRequestInfo[],
    signal: AbortSignal,
    config: Config,
  ): AsyncGenerator<RuntimeTextStreamPart | { type: '__batch_done__'; completed: CompletedToolCall[] }> {
    const emittedApproval = new Set<string>()
    const toolNameByCallId = new Map<string, string>(pendingToolCalls.map((request) => [request.callId, request.name]))
    const subagentProgressMap = new Map<string, Record<string, unknown>>()

    // Queue + notifier so callbacks can push parts that the generator yields immediately
    const queue: Array<RuntimeTextStreamPart | { type: '__batch_done__'; completed: CompletedToolCall[] }> = []
    let notifyReady: (() => void) | null = null
    const enqueue = (part: RuntimeTextStreamPart | { type: '__batch_done__'; completed: CompletedToolCall[] }) => {
      queue.push(part)
      notifyReady?.()
    }

    let batchDone = false

    const schedulerPromise = new Promise<void>((resolve, reject) => {
      const scheduler = new CoreToolScheduler({
        context: config,
        getPreferredEditor: () => undefined,
        outputUpdateHandler: (toolCallId: string, outputChunk: ToolLiveOutput) => {
          if (isSubagentProgress(outputChunk)) {
            const existing = subagentProgressMap.get(toolCallId)
            const existingActivities = Array.isArray(existing?.recentActivity)
              ? (existing.recentActivity as Array<Record<string, unknown>>)
              : []
            const activityMap = new Map<string, Record<string, unknown>>()
            for (const activity of existingActivities) {
              const id = typeof activity.id === 'string' ? activity.id : undefined
              if (id) activityMap.set(id, activity)
            }
            for (const activity of outputChunk.recentActivity) {
              activityMap.set(activity.id, {
                id: activity.id,
                type: activity.type,
                content: activity.content,
                displayName: activity.displayName,
                description: activity.description,
                args: activity.args,
                status: activity.status,
              })
            }

            const progressData = {
              isSubagentProgress: true,
              agentName: outputChunk.agentName,
              state: outputChunk.state ?? 'running',
              recentActivity: Array.from(activityMap.values()),
            }
            subagentProgressMap.set(toolCallId, progressData)
            enqueue({
              type: 'tool-result',
              toolCallId,
              toolName: toolNameByCallId.get(toolCallId) ?? 'unknown',
              input: {},
              output: progressData,
              preliminary: true,
              dynamic: true,
            })
            return
          }

          const text = toPlainText(outputChunk as string | AnsiOutput)
          if (!text) return
          enqueue({
            type: 'tool-result',
            toolCallId,
            toolName: toolNameByCallId.get(toolCallId) ?? 'unknown',
            input: {},
            output: { output: text },
            preliminary: true,
            dynamic: true,
          })
        },
        onToolCallsUpdate: (toolCalls) => {
          for (const toolCall of toolCalls) {
            if (toolCall.status !== 'awaiting_approval') continue
            if (emittedApproval.has(toolCall.request.callId)) continue
            emittedApproval.add(toolCall.request.callId)

            const waitingToolCall = toolCall as WaitingToolCall
            const approvalId = randomUUID()
            const details = waitingToolCall.confirmationDetails

            if ('onConfirm' in details) {
              const wrappedOnConfirm = details.onConfirm as (
                outcome: ToolConfirmationOutcome,
                payload?: Record<string, unknown>,
              ) => Promise<void>
              const invocation = waitingToolCall.invocation as unknown as Record<string, unknown>
              const confirmType = (details as { type?: string }).type

              this.pendingApprovals.set(approvalId, {
                toolCallId: waitingToolCall.request.callId,
                onConfirm: async (outcome, payload) => {
                  if (payload) {
                    if (confirmType === 'ask_user' && 'answers' in payload) {
                      invocation.userAnswers = payload.answers
                    }
                    if (confirmType === 'exit_plan_mode' && 'approved' in payload) {
                      invocation.approvalPayload = payload
                    }
                  }
                  await wrappedOnConfirm(outcome, payload)
                },
              })
            }

            const confirmationDetails = waitingToolCall.confirmationDetails as ToolCallConfirmationDetails
            const providerMetadata: JsonSchemaObject = {
              confirmationType: confirmationDetails.type,
              title: (confirmationDetails as { title?: string }).title,
            }
            if (confirmationDetails.type === 'edit') {
              const detail = confirmationDetails as { fileName?: string; fileDiff?: string }
              providerMetadata.fileName = detail.fileName
              providerMetadata.fileDiff = detail.fileDiff
            } else if (confirmationDetails.type === 'exec') {
              const detail = confirmationDetails as { command?: string }
              providerMetadata.command = detail.command
            } else if (confirmationDetails.type === 'mcp') {
              const detail = confirmationDetails as { serverName?: string; toolName?: string }
              providerMetadata.serverName = detail.serverName
              providerMetadata.toolDisplayName = detail.toolName
            }

            enqueue({
              type: 'tool-approval-request',
              approvalId,
              toolCall: {
                type: 'tool-call',
                toolCallId: waitingToolCall.request.callId,
                toolName: waitingToolCall.request.name,
                input: waitingToolCall.request.args,
                providerExecuted: true,
                providerMetadata: { 'gemini-cli': providerMetadata },
                dynamic: true,
              },
            })
          }
        },
        onAllToolCallsComplete: async (completedCalls) => {
          for (const call of completedCalls) {
            const savedProgress = subagentProgressMap.get(call.request.callId)
            if (savedProgress) {
              enqueue({
                type: 'tool-result',
                toolCallId: call.request.callId,
                toolName: call.request.name,
                input: call.request.args,
                output: {
                  ...savedProgress,
                  state: call.status === 'error' ? 'error' : 'completed',
                },
                providerExecuted: true,
                dynamic: true,
              })
              continue
            }

            const responseParts = call.response?.responseParts ?? []
            const resultText = responseParts
              .map((part) => part.text ?? (part.functionResponse ? JSON.stringify(part.functionResponse) : ''))
              .join('')

            enqueue({
              type: 'tool-result',
              toolCallId: call.request.callId,
              toolName: call.request.name,
              input: call.request.args,
              output: { output: resultText },
              providerExecuted: true,
              dynamic: true,
            })
          }
          enqueue({ type: '__batch_done__', completed: completedCalls })
          resolve()
        },
      })

      scheduler.schedule(pendingToolCalls, signal).catch(reject)
    })

    // Yield parts as they arrive from callbacks
    while (!batchDone) {
      // Drain anything already queued
      while (queue.length > 0) {
        const item = queue.shift()!
        if (item.type === '__batch_done__') {
          batchDone = true
          yield item
          break
        }
        yield item
      }
      if (batchDone) break
      // Wait for next enqueue or scheduler completion
      await Promise.race([
        schedulerPromise,
        new Promise<void>((r) => { notifyReady = r }),
      ])
      notifyReady = null
    }

    // Make sure scheduler promise is settled (propagate errors)
    await schedulerPromise
  }

  async *stream(params: RuntimeStreamParams): AsyncIterable<RuntimeStreamPart> {
    try {
      const { config, geminiClient } = await this.ensureRuntimeInitialized()
      const signal = this.createAbortSignal(params.signal)
      this.logger.info(`Starting stream with model ${this.currentModelId}`)

      if (isCompactCommand(params.messages)) {
        const compactParts = await this.runCompactCommand(geminiClient)
        for (const part of compactParts) {
          yield part
        }
        return
      }

      if (!this.chatStarted) {
        this.logger.debug('Bootstrapping Gemini chat history')
        const { contents } = mapMessagesToGeminiFormat(params.messages)
        const historyContents = contents.length > 1 ? contents.slice(0, -1) : []
        await geminiClient.startChat(historyContents)
        await geminiClient.setTools()
        this.chatStarted = true
      }

      yield { type: 'start' }

      let nextRequest: PartListUnion = extractLatestUserParts(params.messages)
      let totalInputTokens = 0
      let totalOutputTokens = 0

      while (true) {
        const requestMetadata: GeminiRequestMetadata = { body: nextRequest }
        yield { type: 'start-step', request: requestMetadata, warnings: [] }

        const promptId = randomUUID()
        const turnIterator = this.runOneTurnStreaming(nextRequest, promptId, signal)[Symbol.asyncIterator]()
        let turnResult!: {
          pendingToolCalls: ToolCallRequestInfo[]
          inputTokens: number
          outputTokens: number
          rawFinishReason: string | undefined
        }
        while (true) {
          const next = await turnIterator.next()
          if (next.done) {
            turnResult = next.value
            break
          }
          yield next.value
        }
        this.logger.debug(`Turn completed with ${turnResult.pendingToolCalls.length} pending tool calls`)

        totalInputTokens += turnResult.inputTokens
        totalOutputTokens += turnResult.outputTokens
        this.sessionId = config.getSessionId() || this.sessionId

        if (turnResult.pendingToolCalls.length === 0) {
          this.logger.info('Stream completed without further tool calls')
          yield {
            type: 'message-metadata',
            metadata: this.buildMessageMetadata(
              turnResult.inputTokens,
              turnResult.inputTokens,
              turnResult.outputTokens,
            ),
          }
          yield {
            type: 'finish-step',
            response: this.makeResponseMetadata(),
            usage: buildUsage(turnResult.inputTokens, turnResult.outputTokens),
            performance: UNMEASURED_STEP_PERFORMANCE,
            finishReason: 'stop',
            rawFinishReason: turnResult.rawFinishReason,
            providerMetadata: this.getSessionProviderMetadata(turnResult.inputTokens),
          }
          break
        }

        let batchCompleted: CompletedToolCall[] = []
        for await (const part of this.runToolBatchStreaming(turnResult.pendingToolCalls, signal, config)) {
          if (part.type === '__batch_done__') {
            batchCompleted = part.completed
            break
          }
          yield part
        }
        this.logger.debug(`Completed tool batch with ${batchCompleted.length} tool results`)

        geminiClient.getChat().recordCompletedToolCalls(
          config.getActiveModel(),
          batchCompleted,
        )
        nextRequest = batchCompleted.flatMap((call) => call.response?.responseParts ?? [])

        yield {
          type: 'message-metadata',
          metadata: this.buildMessageMetadata(
            turnResult.inputTokens,
            turnResult.inputTokens,
            turnResult.outputTokens,
          ),
        }
        yield {
          type: 'finish-step',
          response: this.makeResponseMetadata(),
          usage: buildUsage(turnResult.inputTokens, turnResult.outputTokens),
          performance: UNMEASURED_STEP_PERFORMANCE,
          finishReason: 'tool-calls',
          rawFinishReason: turnResult.rawFinishReason,
          providerMetadata: this.getSessionProviderMetadata(turnResult.inputTokens),
        }
      }

      yield {
        type: 'finish',
        finishReason: 'stop',
        rawFinishReason: 'STOP',
        totalUsage: buildUsage(totalInputTokens, totalOutputTokens),
      }
    } catch (error) {
      const abortLike = error instanceof Error && error.name === 'AbortError'
      if (abortLike) {
        this.logger.info('Stream aborted')
        yield { type: 'abort' }
        return
      }
      this.logger.error(`Stream failed: ${error instanceof Error ? error.message : String(error)}`)
      yield { type: 'error', error }
    }
  }

  abort(): void {
    this.logger.info('Abort requested')
    this.abortController?.abort()
    this.abortController = null
  }

  async dispose(): Promise<void> {
    this.abort()
    this.geminiClient?.dispose()
    this.geminiClient = undefined
    this.coreConfig = undefined
    this.runtimeInitPromise = undefined
    this.chatStarted = false
    this.pendingApprovals.clear()
  }

  resolvePermission(approvalId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingApprovals.get(approvalId)
    if (!pending) return false
    this.pendingApprovals.delete(approvalId)

    const outcome =
      decision.type === 'allow'
        ? ToolConfirmationOutcome.ProceedOnce
        : decision.type === 'allow-always'
          ? ToolConfirmationOutcome.ProceedAlways
          : ToolConfirmationOutcome.Cancel

    pending.onConfirm(
      outcome,
      'updatedInput' in decision ? decision.updatedInput : undefined,
    ).catch(() => {})
    return true
  }

  getSessionId(): string | undefined {
    const currentSessionId = this.coreConfig?.getSessionId()
    if (currentSessionId) {
      this.sessionId = currentSessionId
      return currentSessionId
    }
    return this.sessionId
  }

  async injectMessage(content: string): Promise<void> {
    const { config } = await this.ensureRuntimeInitialized()
    this.logger.info('Injecting steering message')
    config.injectionService.addInjection(content, 'user_steering')
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
