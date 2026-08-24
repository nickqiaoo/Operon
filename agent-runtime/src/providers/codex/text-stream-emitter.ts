import { randomUUID } from 'node:crypto'
import type { RuntimeStreamPart, RuntimeTextStreamPart } from '../../types.js'
import { buildStreamMessageMetadata, type StreamMessageMetadata } from '../../stream-message-metadata.js'

interface JsonRecord {
  [key: string]: JsonValue | undefined
}

type JsonValue = string | number | boolean | null | JsonRecord | JsonValue[]

type FinishReason = Extract<RuntimeTextStreamPart, { type: 'finish-step' }>['finishReason']
type FinishStepUsage = Extract<RuntimeTextStreamPart, { type: 'finish-step' }>['usage']
type ToolCallPart = Extract<RuntimeTextStreamPart, { type: 'tool-call' }>
type FinishStepProviderMetadata = Extract<RuntimeTextStreamPart, { type: 'finish-step' }>['providerMetadata']

export interface ToolExecutionStats {
  totalCalls: number
  byType: {
    commands: number
    fileChanges: number
    mcpTools: number
    webSearches: number
    collabAgents: number
  }
  totalDurationMs: number
}

export interface CodexUsageMetadata {
  model: string
  threadId: string
  turnId: string
  status: string
  toolStats: ToolExecutionStats
  hasReasoning: boolean
  completedAt: string
}

export type CodexAccountInfo =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string; planType: string }

export interface CodexRateLimitWindow {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

export interface CodexCreditsSnapshot {
  hasCredits: boolean
  unlimited: boolean
  balance: string | null
}

export interface CodexRateLimitSnapshot {
  limitId: string | null
  limitName: string | null
  primary: CodexRateLimitWindow | null
  secondary: CodexRateLimitWindow | null
  credits: CodexCreditsSnapshot | null
  planType: string | null
}

export interface TurnError {
  code?: string
  message?: string
  codexErrorInfo?: string
  additionalDetails?: unknown
}

export interface TokenUsageBreakdown {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export interface ThreadTokenUsage {
  last: TokenUsageBreakdown
  total: TokenUsageBreakdown
  modelContextWindow?: number | null
}

export interface StreamEmitterOptions {
  threadId: string
  turnId: string
  modelId: string
}

const isInvalidStateError = (error: unknown): boolean => {
  if (!(error instanceof TypeError)) return false
  const withCode = error as { code?: unknown }
  if (withCode.code === 'ERR_INVALID_STATE') return true
  return typeof error.message === 'string' && error.message.includes('Invalid state')
}

function serializeJsonObject(value: unknown): JsonRecord {
  return JSON.parse(JSON.stringify(value)) as JsonRecord
}

function mapFinishReason(status?: string, error?: TurnError | null): {
  unified: FinishReason
  raw: string | undefined
} {
  switch (status) {
    case 'completed':
    case 'interrupted':
      return { unified: 'stop', raw: status }
    case 'failed':
      return { unified: 'error', raw: error ? JSON.stringify(error) : status }
    default:
      return { unified: 'other', raw: status }
  }
}

function buildUsage(
  metadata: CodexUsageMetadata,
  latestTokenUsage: TokenUsageBreakdown | null,
): FinishStepUsage {
  const inputTokens = latestTokenUsage?.inputTokens ?? 0
  const cachedInputTokens = latestTokenUsage?.cachedInputTokens ?? 0
  const outputTokens = latestTokenUsage?.outputTokens ?? 0
  const reasoningTokens = latestTokenUsage?.reasoningOutputTokens ?? 0
  return {
    inputTokens,
    inputTokenDetails: {
      noCacheTokens: inputTokens - cachedInputTokens,
      cacheReadTokens: cachedInputTokens,
      cacheWriteTokens: 0,
    },
    outputTokens,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens,
    },
    totalTokens: inputTokens + outputTokens,
    raw: serializeJsonObject(metadata),
    reasoningTokens,
    cachedInputTokens,
  }
}

function createToolCall(toolCallId: string, toolName: string, input: string, dynamic?: boolean): ToolCallPart {
  return {
    type: 'tool-call',
    toolCallId,
    toolName,
    input,
    providerExecuted: true,
    ...(dynamic ? { dynamic: true } : {}),
  }
}

export class CodexTextStreamEmitter {
  private textId = randomUUID()
  private reasoningId = randomUUID()
  private textStarted = false
  private reasoningStarted = false
  private hadReasoning = false
  private closed = false
  private emittedToolCalls = new Map<string, ToolCallPart>()
  private toolStats: ToolExecutionStats = {
    totalCalls: 0,
    byType: { commands: 0, fileChanges: 0, mcpTools: 0, webSearches: 0, collabAgents: 0 },
    totalDurationMs: 0,
  }
  private latestTokenUsage: TokenUsageBreakdown | null = null
  private modelContextWindow: number | null = null
  private account: CodexAccountInfo | null | undefined
  private requiresOpenaiAuth: boolean | undefined
  private authMode: string | null | undefined
  private accountPlanType: string | null | undefined
  private rateLimits: CodexRateLimitSnapshot | null | undefined
  private rateLimitsByLimitId: Record<string, CodexRateLimitSnapshot> | null | undefined
  private latestGoal: import('./sdk/protocol/index.js').CodexGoal | undefined
  private contextCompaction: NonNullable<StreamMessageMetadata['contextCompaction']> | undefined

  constructor(
    private controller: ReadableStreamDefaultController<RuntimeStreamPart>,
    private options: StreamEmitterOptions,
  ) {}

  private enqueue(part: RuntimeStreamPart): void {
    if (this.closed) return
    try {
      this.controller.enqueue(part)
    } catch (error) {
      if (isInvalidStateError(error)) {
        this.closed = true
        return
      }
      throw error
    }
  }

  recordToolExecution(
    toolType: 'command' | 'fileChange' | 'mcpTool' | 'webSearch' | 'collabAgent',
    durationMs?: number,
  ): void {
    this.toolStats.totalCalls += 1
    switch (toolType) {
      case 'command':
        this.toolStats.byType.commands += 1
        break
      case 'fileChange':
        this.toolStats.byType.fileChanges += 1
        break
      case 'mcpTool':
        this.toolStats.byType.mcpTools += 1
        break
      case 'webSearch':
        this.toolStats.byType.webSearches += 1
        break
      case 'collabAgent':
        this.toolStats.byType.collabAgents += 1
        break
    }
    if (durationMs !== undefined && durationMs > 0) {
      this.toolStats.totalDurationMs += durationMs
    }
  }

  updateTokenUsage(usage: ThreadTokenUsage): void {
    this.latestTokenUsage = usage.last
    if (usage.modelContextWindow != null) {
      this.modelContextWindow = usage.modelContextWindow
    }
    this.emitMessageMetadata()
  }

  updateAccountSummary(payload: { authMode: string | null; planType: string | null }): void {
    this.authMode = payload.authMode
    this.accountPlanType = payload.planType ?? this.accountPlanType
    this.emitMessageMetadata()
  }

  updateRateLimitSnapshot(snapshot: CodexRateLimitSnapshot | null): void {
    this.rateLimits = snapshot
    if (snapshot?.limitId) {
      this.rateLimitsByLimitId = {
        ...(this.rateLimitsByLimitId ?? {}),
        [snapshot.limitId]: snapshot,
      }
    }
    this.emitMessageMetadata()
  }

  /**
   * Forward a thread-goal update to the client as message metadata. The latest
   * goal is also folded into every subsequent metadata flush so it survives
   * replace-style metadata merges on the client.
   */
  emitGoalUpdate(goal: import('./sdk/protocol/index.js').CodexGoal): void {
    this.latestGoal = goal
    this.emitMessageMetadata()
  }

  emitContextCompactionStarted(id: string): void {
    this.contextCompaction = { id, status: 'in_progress' }
    this.emitMessageMetadata()
  }

  emitContextCompactionCompleted(id: string): void {
    this.contextCompaction = { id, status: 'completed' }
    this.emitMessageMetadata()
  }

  emitTextDelta(text: string): void {
    if (!this.textStarted) {
      this.textStarted = true
      this.enqueue({ type: 'text-start', id: this.textId })
    }
    this.enqueue({ type: 'text-delta', id: this.textId, text })
  }

  emitReasoningDelta(text: string, isSummary = false): void {
    if (!this.reasoningStarted) {
      this.reasoningStarted = true
      this.enqueue({ type: 'reasoning-start', id: this.reasoningId })
    }
    if (text.length > 0) this.hadReasoning = true
    this.enqueue({
      type: 'reasoning-delta',
      id: this.reasoningId,
      text,
      ...(isSummary ? { providerMetadata: { codex: { isSummary: true } } } : {}),
    })
  }

  flushText(): void {
    if (!this.textStarted) return
    this.enqueue({ type: 'text-end', id: this.textId })
    this.textStarted = false
    this.textId = randomUUID()
  }

  flushReasoning(): void {
    if (!this.reasoningStarted) return
    this.enqueue({ type: 'reasoning-end', id: this.reasoningId })
    this.reasoningStarted = false
    this.reasoningId = randomUUID()
  }

  emitToolInput(toolCallId: string, toolName: string, input: string, dynamic?: boolean): void {
    this.enqueue({
      type: 'tool-input-start',
      id: toolCallId,
      toolName,
      providerExecuted: true,
      ...(dynamic ? { dynamic: true } : {}),
    })
    if (input) {
      this.enqueue({ type: 'tool-input-delta', id: toolCallId, delta: input })
    }
    this.enqueue({ type: 'tool-input-end', id: toolCallId })
  }

  emitToolCall(toolCallId: string, toolName: string, input: string, dynamic?: boolean): void {
    const part = createToolCall(toolCallId, toolName, input, dynamic)
    this.emittedToolCalls.set(toolCallId, part)
    this.enqueue(part)
  }

  emitToolResult(
    toolCallId: string,
    toolName: string,
    output: Record<string, unknown>,
    isError?: boolean,
    dynamic?: boolean,
    preliminary?: boolean,
  ): void {
    if (isError) {
      this.enqueue({
        type: 'tool-error',
        toolCallId,
        toolName,
        input: this.emittedToolCalls.get(toolCallId)?.input ?? '',
        error: new Error(typeof output.error === 'string' ? output.error : 'Tool execution failed'),
        providerExecuted: true,
        ...(dynamic ? { dynamic: true } : {}),
      })
      return
    }
    this.enqueue({
      type: 'tool-result',
      toolCallId,
      toolName,
      input: this.emittedToolCalls.get(toolCallId)?.input ?? '',
      output,
      providerExecuted: true,
      ...(dynamic ? { dynamic: true } : {}),
      ...(preliminary ? { preliminary: true } : {}),
    })
  }

  emitApprovalRequest(itemId: string): void {
    const toolCall = this.emittedToolCalls.get(itemId) ?? createToolCall(itemId, 'tool', '{}', true)
    this.enqueue({ type: 'tool-approval-request', approvalId: itemId, toolCall })
  }

  private buildProviderMetadata(promptTokens: number): FinishStepProviderMetadata {
    const codexMeta: JsonRecord = {
      sessionId: this.options.threadId,
    }
    if (promptTokens > 0) {
      const contextUsage: JsonRecord = { promptTokens }
      if (this.modelContextWindow && this.modelContextWindow > 0) {
        contextUsage.contextWindow = this.modelContextWindow
        contextUsage.percentUsed = promptTokens / this.modelContextWindow
      }
      codexMeta.contextUsage = contextUsage
    }
    if (this.account !== undefined) codexMeta.account = serializeJsonObject(this.account)
    if (this.requiresOpenaiAuth !== undefined) codexMeta.requiresOpenaiAuth = this.requiresOpenaiAuth
    if (this.authMode !== undefined) codexMeta.authMode = this.authMode
    if (this.accountPlanType !== undefined) codexMeta.planType = this.accountPlanType
    if (this.rateLimits !== undefined) codexMeta.rateLimits = serializeJsonObject(this.rateLimits)
    if (this.rateLimitsByLimitId !== undefined) {
      codexMeta.rateLimitsByLimitId = serializeJsonObject(this.rateLimitsByLimitId)
    }
    return { codex: codexMeta }
  }

  private buildCurrentMessageMetadata() {
    const promptTokens = this.latestTokenUsage?.inputTokens ?? 0
    const usage = this.latestTokenUsage
      ? buildUsage(
          {
            model: this.options.modelId,
            threadId: this.options.threadId,
            turnId: this.options.turnId,
            status: 'in_progress',
            toolStats: this.toolStats,
            hasReasoning: this.hadReasoning,
            completedAt: new Date().toISOString(),
          },
          this.latestTokenUsage,
        )
      : undefined
    const base = buildStreamMessageMetadata({
      providerMetadata: this.buildProviderMetadata(promptTokens),
      usage,
    })
    return {
      ...base,
      ...(this.latestGoal ? { codexGoal: this.latestGoal } : {}),
      ...(this.contextCompaction ? { contextCompaction: this.contextCompaction } : {}),
      ...(this.contextCompaction?.status === 'completed'
        ? { compacted: { compacted: true, id: this.contextCompaction.id } }
        : {}),
    }
  }

  private emitMessageMetadata(): void {
    const metadata = this.buildCurrentMessageMetadata()
    if (Object.keys(metadata).length === 0) return
    this.enqueue({
      type: 'message-metadata',
      metadata,
    })
  }

  emitFinish(status?: string, error?: TurnError | null): void {
    if (error?.message && !this.textStarted) {
      const errorText = error.codexErrorInfo
        ? `Error: ${error.message}\n\n${error.codexErrorInfo}`
        : `Error: ${error.message}`
      this.emitTextDelta(errorText)
    }

    if (this.textStarted) {
      this.enqueue({ type: 'text-end', id: this.textId })
      this.textStarted = false
    }
    if (this.reasoningStarted) {
      this.enqueue({ type: 'reasoning-end', id: this.reasoningId })
      this.reasoningStarted = false
    }

    const metadata: CodexUsageMetadata = {
      model: this.options.modelId,
      threadId: this.options.threadId,
      turnId: this.options.turnId,
      status: status ?? 'unknown',
      toolStats: this.toolStats,
      hasReasoning: this.hadReasoning,
      completedAt: new Date().toISOString(),
    }
    const usage = buildUsage(metadata, this.latestTokenUsage)
    const finishReason = mapFinishReason(status, error)
    const promptTokens = this.latestTokenUsage?.inputTokens ?? 0

    this.emitMessageMetadata()

    this.enqueue({
      type: 'finish-step',
      response: {
        id: this.options.turnId,
        timestamp: new Date(),
        modelId: this.options.modelId,
      },
      usage,
      finishReason: finishReason.unified,
      rawFinishReason: finishReason.raw,
      providerMetadata: this.buildProviderMetadata(promptTokens),
    })

    this.enqueue({
      type: 'finish',
      finishReason: finishReason.unified,
      rawFinishReason: finishReason.raw,
      totalUsage: usage,
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.controller.close()
    } catch (error) {
      if (isInvalidStateError(error)) return
      throw error
    }
  }
}
