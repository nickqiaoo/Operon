import { randomUUID } from 'node:crypto'
import type { LanguageModelUsage } from 'ai'
import type {
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { RuntimeStreamPart, RuntimeTextStreamPart } from '../../types.js'
import { buildStreamMessageMetadata } from '../../stream-message-metadata.js'
import type { ToolStreamState } from './types.js'
import { UNMEASURED_STEP_PERFORMANCE } from '../../stream-utils.js'

interface JsonRecord {
  [key: string]: JsonValue | undefined
}

type JsonValue = string | number | boolean | null | JsonRecord | JsonValue[]
type FinishReason = Extract<RuntimeTextStreamPart, { type: 'finish-step' }>['finishReason']
type StartWarnings = Extract<RuntimeTextStreamPart, { type: 'start-step' }>['warnings']
type ToolCallPart = Extract<RuntimeTextStreamPart, { type: 'tool-call' }>

type ClaudeRawUsage = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

const MAX_TOOL_RESULT_SIZE = 10_000
const MAX_TOOL_INPUT_SIZE = 1_048_576
const MAX_TOOL_INPUT_WARN = 102_400
const MAX_DELTA_CALC_SIZE = 10_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const toFiniteNumberOrUndefined = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

function createEmptyRawUsage(): Required<ClaudeRawUsage> {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
}

function normalizeRawUsage(usage: unknown): ClaudeRawUsage | undefined {
  if (!isRecord(usage)) return undefined
  const inputTokens = toFiniteNumberOrUndefined(usage.input_tokens)
  const outputTokens = toFiniteNumberOrUndefined(usage.output_tokens)
  const cacheWrite = toFiniteNumberOrUndefined(usage.cache_creation_input_tokens)
  const cacheRead = toFiniteNumberOrUndefined(usage.cache_read_input_tokens)

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheWrite === undefined &&
    cacheRead === undefined
  ) {
    return undefined
  }

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
  }
}

function mergeRawUsage(previous: Required<ClaudeRawUsage>, incoming: ClaudeRawUsage): Required<ClaudeRawUsage> {
  return {
    input_tokens:
      typeof incoming.input_tokens === 'number' && incoming.input_tokens > 0
        ? incoming.input_tokens
        : previous.input_tokens,
    output_tokens:
      typeof incoming.output_tokens === 'number' ? incoming.output_tokens : previous.output_tokens,
    cache_creation_input_tokens:
      typeof incoming.cache_creation_input_tokens === 'number' && incoming.cache_creation_input_tokens > 0
        ? incoming.cache_creation_input_tokens
        : previous.cache_creation_input_tokens,
    cache_read_input_tokens:
      typeof incoming.cache_read_input_tokens === 'number' && incoming.cache_read_input_tokens > 0
        ? incoming.cache_read_input_tokens
        : previous.cache_read_input_tokens,
  }
}

function toLanguageModelUsage(usage: ClaudeRawUsage): LanguageModelUsage {
  const inputTokens = usage.input_tokens ?? 0
  const outputTokens = usage.output_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0

  return {
    inputTokens: inputTokens + cacheWrite + cacheRead,
    inputTokenDetails: {
      noCacheTokens: inputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    },
    outputTokens,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: 0,
    },
    totalTokens: inputTokens + cacheWrite + cacheRead + outputTokens,
    raw: usage as JsonRecord,
  }
}

function mapFinishReason(subtype?: string): { unified: FinishReason; raw: string | undefined } {
  switch (subtype) {
    case 'success':
      return { unified: 'stop', raw: subtype }
    case 'error_max_turns':
      return { unified: 'length', raw: subtype }
    case 'error_during_execution':
    case 'error_max_budget_usd':
    case 'error_max_structured_output_retries':
      return { unified: 'error', raw: subtype }
    case undefined:
      return { unified: 'stop', raw: undefined }
    default:
      return { unified: 'other', raw: subtype }
  }
}

function truncateForLog(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const remaining = value.length - maxLength
  return `${value.slice(0, maxLength)}... (+${remaining} chars)`
}

function truncateToolResultForStream(result: unknown, maxSize = MAX_TOOL_RESULT_SIZE): unknown {
  if (typeof result === 'string') {
    if (result.length <= maxSize) return result
    return `${result.slice(0, maxSize)}\n...[truncated ${result.length - maxSize} chars]`
  }

  if (typeof result !== 'object' || result === null) return result

  if (Array.isArray(result)) {
    let largestIndex = -1
    let largestSize = 0
    for (let index = 0; index < result.length; index += 1) {
      const value = result[index]
      if (typeof value === 'string' && value.length > largestSize) {
        largestIndex = index
        largestSize = value.length
      }
    }
    if (largestIndex >= 0 && largestSize > maxSize) {
      const cloned = [...result]
      cloned[largestIndex] = `${(result[largestIndex] as string).slice(0, maxSize)}\n...[truncated ${largestSize - maxSize} chars]`
      return cloned
    }
    return result
  }

  const objectResult = result as Record<string, unknown>
  let largestKey: string | null = null
  let largestSize = 0
  for (const [key, value] of Object.entries(objectResult)) {
    if (typeof value === 'string' && value.length > largestSize) {
      largestKey = key
      largestSize = value.length
    }
  }
  if (largestKey && largestSize > maxSize) {
    return {
      ...objectResult,
      [largestKey]: `${(objectResult[largestKey] as string).slice(0, maxSize)}\n...[truncated ${largestSize - maxSize} chars]`,
    }
  }
  return result
}

function createToolCall(toolCallId: string, toolName: string, input: string, parentToolCallId?: string | null): ToolCallPart {
  return {
    type: 'tool-call',
    toolCallId,
    toolName,
    input,
    providerExecuted: true,
    dynamic: true,
    providerMetadata: {
      'claude-code': {
        rawInput: input,
        parentToolCallId: parentToolCallId ?? null,
      },
    },
  }
}

type BuilderOptions = {
  controller: ReadableStreamDefaultController<RuntimeStreamPart>
  modelId: string
  requestBody: unknown
  warnings: StartWarnings
  getSessionId: () => string | undefined
}

export class ClaudeTextStreamBuilder {
  private closed = false
  private started = false
  private textPartId: string | undefined
  private reasoningPartId: string | undefined
  private streamedTextLength = 0
  private accumulatedText = ''
  private textStreamedViaContentBlock = false
  private hasReceivedStreamEvents = false
  private hasStreamedJson = false
  private currentTurnUsage = createEmptyRawUsage()
  private pendingStepUsage: LanguageModelUsage | undefined
  private pendingStepRawMetadata: JsonRecord | undefined
  private latestTotalUsage: LanguageModelUsage | undefined
  private readonly toolStates = new Map<string, ToolStreamState>()
  private readonly pendingApprovalRequests = new Map<string, Extract<RuntimeTextStreamPart, { type: 'tool-approval-request' }>>()
  private readonly toolBlocksByIndex = new Map<number, string>()
  private readonly toolInputAccumulators = new Map<string, string>()
  private readonly textBlocksByIndex = new Map<number, string>()
  private readonly reasoningBlocksByIndex = new Map<number, string>()

  constructor(private readonly options: BuilderOptions) {}

  getLatestTotalUsage(): LanguageModelUsage | undefined {
    return this.latestTotalUsage
  }

  private emitRuntimePart(part: RuntimeStreamPart): void {
    if (this.closed) return
    this.options.controller.enqueue(part)
  }

  emitStart(): void {
    if (this.started) return
    this.started = true
    this.enqueue({ type: 'start' })
    this.enqueue({
      type: 'start-step',
      request: { body: this.options.requestBody },
      warnings: this.options.warnings,
    })
  }

  private enqueue(part: RuntimeTextStreamPart): void {
    if (this.closed) return
    this.options.controller.enqueue(part)
  }

  private resetMessageState(): void {
    this.textPartId = undefined
    this.reasoningPartId = undefined
    this.streamedTextLength = 0
    this.accumulatedText = ''
    this.textStreamedViaContentBlock = false
    this.hasStreamedJson = false
    this.toolBlocksByIndex.clear()
    this.toolInputAccumulators.clear()
    this.textBlocksByIndex.clear()
    this.reasoningBlocksByIndex.clear()
  }

  private buildProviderMetadata(extra?: JsonRecord): { 'claude-code': JsonRecord } | undefined {
    const sessionId = this.options.getSessionId()
    const metadata: JsonRecord = {
      ...(sessionId ? { sessionId } : {}),
      ...(this.pendingStepRawMetadata ?? {}),
      ...(extra ?? {}),
    }
    return Object.keys(metadata).length > 0 ? { 'claude-code': metadata } : undefined
  }

  private closeTextPart(): void {
    if (!this.textPartId) return
    const id = this.textPartId
    for (const [blockIndex, partId] of this.textBlocksByIndex.entries()) {
      if (partId === id) {
        this.textBlocksByIndex.delete(blockIndex)
      }
    }
    this.enqueue({ type: 'text-end', id })
    this.textPartId = undefined
  }

  private closeReasoningPart(): void {
    if (!this.reasoningPartId) return
    const id = this.reasoningPartId
    for (const [blockIndex, partId] of this.reasoningBlocksByIndex.entries()) {
      if (partId === id) {
        this.reasoningBlocksByIndex.delete(blockIndex)
      }
    }
    this.enqueue({ type: 'reasoning-end', id })
    this.reasoningPartId = undefined
  }

  private emitMessageMetadata(providerMetadata: unknown, usage: LanguageModelUsage | undefined): void {
    const metadata = buildStreamMessageMetadata({
      providerMetadata,
      usage,
    })
    if (Object.keys(metadata).length === 0) return
    this.emitRuntimePart({
      type: 'message-metadata',
      metadata,
    })
  }

  private serializeToolInput(input: unknown): string {
    const serialized = typeof input === 'string'
      ? input
      : input === undefined
        ? ''
        : (() => {
            try {
              return JSON.stringify(input)
            } catch {
              return String(input)
            }
          })()

    const length = serialized.length
    if (length > MAX_TOOL_INPUT_SIZE) {
      throw new Error(
        `Tool input exceeds maximum size of ${MAX_TOOL_INPUT_SIZE} bytes (got ${length} bytes).`,
      )
    }
    if (length > MAX_TOOL_INPUT_WARN) {
      const preview = truncateForLog(serialized, 160)
      this.pendingStepRawMetadata = {
        ...(this.pendingStepRawMetadata ?? {}),
        largeToolInputWarning: `len=${length} preview=${preview}`,
      }
    }
    return serialized
  }

  private normalizeToolResult(result: unknown): unknown {
    if (typeof result === 'string') {
      try {
        return JSON.parse(result)
      } catch {
        return result
      }
    }

    if (Array.isArray(result) && result.length > 0) {
      const textBlocks = result
        .filter((block): block is { type: 'text'; text: string } => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)

      if (textBlocks.length !== result.length) return result
      const combined = textBlocks.join('\n')
      try {
        return textBlocks.length === 1 ? JSON.parse(textBlocks[0]) : JSON.parse(combined)
      } catch {
        return textBlocks.length === 1 ? textBlocks[0] : combined
      }
    }

    return result
  }

  private ensureToolState(toolId: string, toolName: string, parentToolCallId?: string | null): ToolStreamState {
    let state = this.toolStates.get(toolId)
    if (!state) {
      state = {
        name: toolName,
        inputStarted: false,
        inputClosed: false,
        callEmitted: false,
        parentToolCallId: toolName === 'Task' ? null : (parentToolCallId ?? null),
        hasAssistantSnapshot: false,
      }
      this.toolStates.set(toolId, state)
    } else {
      state.name = toolName
      if (!state.parentToolCallId && parentToolCallId && toolName !== 'Task') {
        state.parentToolCallId = parentToolCallId
      }
    }
    return state
  }

  private startToolInput(toolId: string, state: ToolStreamState): void {
    if (state.inputStarted) return
    this.enqueue({
      type: 'tool-input-start',
      id: toolId,
      toolName: state.name,
      providerExecuted: true,
      dynamic: true,
      providerMetadata: {
        'claude-code': {
          parentToolCallId: state.parentToolCallId ?? null,
        },
      },
    })
    state.inputStarted = true
  }

  private closeToolInput(toolId: string, state: ToolStreamState): void {
    if (!state.inputStarted || state.inputClosed) return
    this.enqueue({ type: 'tool-input-end', id: toolId })
    state.inputClosed = true
  }

  private syncToolInputSnapshot(toolId: string, state: ToolStreamState, serializedInput: string): void {
    if (!serializedInput.length) return
    let deltaPayload = ''

    if (state.lastSerializedInput === undefined) {
      if (serializedInput.length <= MAX_DELTA_CALC_SIZE) {
        deltaPayload = serializedInput
      }
    } else if (
      serializedInput.length <= MAX_DELTA_CALC_SIZE &&
      state.lastSerializedInput.length <= MAX_DELTA_CALC_SIZE &&
      serializedInput.startsWith(state.lastSerializedInput)
    ) {
      deltaPayload = serializedInput.slice(state.lastSerializedInput.length)
    }

    if (deltaPayload && !state.inputClosed && !state.callEmitted) {
      this.enqueue({ type: 'tool-input-delta', id: toolId, delta: deltaPayload })
    }

    state.lastSerializedInput = serializedInput
  }

  private emitToolCall(toolId: string, state: ToolStreamState): void {
    if (state.callEmitted) return
    this.closeToolInput(toolId, state)
    this.enqueue(createToolCall(toolId, state.name, state.lastSerializedInput ?? '', state.parentToolCallId))
    state.callEmitted = true
    const pendingApproval = this.pendingApprovalRequests.get(toolId)
    if (pendingApproval) {
      this.pendingApprovalRequests.delete(toolId)
      this.enqueue(pendingApproval)
    }
  }

  private finalizeToolCalls(): void {
    for (const [toolId, state] of this.toolStates) {
      this.emitToolCall(toolId, state)
    }
    this.toolStates.clear()
  }

  private flushStep(reason: FinishReason, rawReason: string | undefined, extraMetadata?: JsonRecord): void {
    this.closeTextPart()
    this.closeReasoningPart()
    this.finalizeToolCalls()

    const usage = this.pendingStepUsage ?? toLanguageModelUsage(this.currentTurnUsage)
    this.latestTotalUsage = usage
    this.enqueue({
      type: 'finish-step',
      response: {
        id: randomUUID(),
        timestamp: new Date(),
        modelId: this.options.modelId,
      },
      usage,
      performance: UNMEASURED_STEP_PERFORMANCE,
      finishReason: reason,
      rawFinishReason: rawReason,
      providerMetadata: this.buildProviderMetadata(extraMetadata),
    })

    this.pendingStepUsage = undefined
    this.pendingStepRawMetadata = undefined
    this.currentTurnUsage = createEmptyRawUsage()
    this.resetMessageState()
  }

  queueApprovalRequest(
    approvalId: string,
    toolName: string,
    input: Record<string, unknown>,
    parentToolCallId?: string | null,
  ): void {
    const inputText = this.serializeToolInput(input)
    const toolCall = createToolCall(approvalId, toolName, inputText, parentToolCallId)
    const state = this.toolStates.get(approvalId)

    const approvalPart: Extract<RuntimeTextStreamPart, { type: 'tool-approval-request' }> = {
      type: 'tool-approval-request',
      approvalId,
      toolCall,
    }

    if (state?.callEmitted) {
      this.enqueue(approvalPart)
      return
    }

    if (state?.hasAssistantSnapshot) {
      this.emitToolCall(approvalId, state)
      this.enqueue(approvalPart)
      return
    }

    this.pendingApprovalRequests.set(approvalId, approvalPart)
  }

  handleStreamEvent(message: SDKPartialAssistantMessage, isJsonMode: boolean): void {
    const streamParentToolUseId = message.parent_tool_use_id
    const event = message.event as SDKPartialAssistantMessage['event'] & { index?: number }
    const eventType = (event as { type?: unknown }).type

    if (eventType === 'message_start') {
      const startUsage = 'message' in event && isRecord(event.message)
        ? normalizeRawUsage(event.message.usage)
        : undefined
      this.currentTurnUsage = startUsage
        ? mergeRawUsage(createEmptyRawUsage(), startUsage)
        : createEmptyRawUsage()
      return
    }

    if (eventType === 'message_delta') {
      const deltaUsage = normalizeRawUsage((event as { usage?: unknown }).usage)
      if (deltaUsage) {
        this.currentTurnUsage = mergeRawUsage(this.currentTurnUsage, deltaUsage)
      }
      return
    }

    if (eventType === 'message_stop') {
      this.pendingStepUsage = toLanguageModelUsage(this.currentTurnUsage)
      this.emitMessageMetadata(this.buildProviderMetadata(), this.pendingStepUsage)
      return
    }

    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta' &&
      typeof event.delta.text === 'string' &&
      event.delta.text.length > 0
    ) {
      this.hasReceivedStreamEvents = true
      const deltaText = event.delta.text
      if (isJsonMode) {
        this.accumulatedText += deltaText
        this.streamedTextLength += deltaText.length
        return
      }
      if (!this.textPartId) {
        this.textPartId = randomUUID()
        this.enqueue({ type: 'text-start', id: this.textPartId })
      }
      this.enqueue({ type: 'text-delta', id: this.textPartId, text: deltaText })
      this.accumulatedText += deltaText
      this.streamedTextLength += deltaText.length
      return
    }

    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'input_json_delta' &&
      typeof event.delta.partial_json === 'string'
    ) {
      this.hasReceivedStreamEvents = true
      const jsonDelta = event.delta.partial_json
      const blockIndex = typeof event.index === 'number' ? event.index : -1

      if (isJsonMode) {
        if (!this.textPartId) {
          this.textPartId = randomUUID()
          this.enqueue({ type: 'text-start', id: this.textPartId })
        }
        this.enqueue({ type: 'text-delta', id: this.textPartId, text: jsonDelta })
        this.accumulatedText += jsonDelta
        this.streamedTextLength += jsonDelta.length
        this.hasStreamedJson = true
        return
      }

      const toolId = this.toolBlocksByIndex.get(blockIndex)
      if (!toolId) return
      const accumulated = (this.toolInputAccumulators.get(toolId) ?? '') + jsonDelta
      this.toolInputAccumulators.set(toolId, accumulated)
      const state = this.toolStates.get(toolId)
      if (!state) return
      state.lastSerializedInput = accumulated
      if (state.inputClosed || state.callEmitted) return
      this.enqueue({ type: 'tool-input-delta', id: toolId, delta: jsonDelta })
      return
    }

    if (
      event.type === 'content_block_start' &&
      'content_block' in event &&
      isRecord(event.content_block) &&
      event.content_block.type === 'tool_use'
    ) {
      this.hasReceivedStreamEvents = true
      this.closeTextPart()
      const blockIndex = typeof event.index === 'number' ? event.index : -1
      const toolId =
        typeof event.content_block.id === 'string' && event.content_block.id.length > 0
          ? event.content_block.id
          : randomUUID()
      const toolName =
        typeof event.content_block.name === 'string' && event.content_block.name.length > 0
          ? event.content_block.name
          : 'unknown-tool'
      this.toolBlocksByIndex.set(blockIndex, toolId)
      this.toolInputAccumulators.set(toolId, '')
      const state = this.ensureToolState(toolId, toolName, streamParentToolUseId)
      this.startToolInput(toolId, state)
      return
    }

    if (
      event.type === 'content_block_start' &&
      'content_block' in event &&
      isRecord(event.content_block) &&
      event.content_block.type === 'text'
    ) {
      this.hasReceivedStreamEvents = true
      const blockIndex = typeof event.index === 'number' ? event.index : -1
      const partId = randomUUID()
      this.textBlocksByIndex.set(blockIndex, partId)
      this.textPartId = partId
      this.enqueue({ type: 'text-start', id: partId })
      this.textStreamedViaContentBlock = true
      return
    }

    if (
      event.type === 'content_block_start' &&
      'content_block' in event &&
      isRecord(event.content_block) &&
      event.content_block.type === 'thinking'
    ) {
      this.hasReceivedStreamEvents = true
      this.closeTextPart()
      const blockIndex = typeof event.index === 'number' ? event.index : -1
      const partId = randomUUID()
      this.reasoningBlocksByIndex.set(blockIndex, partId)
      this.reasoningPartId = partId
      this.enqueue({ type: 'reasoning-start', id: partId })
      return
    }

    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'thinking_delta' &&
      typeof event.delta.thinking === 'string'
    ) {
      this.hasReceivedStreamEvents = true
      const blockIndex = typeof event.index === 'number' ? event.index : -1
      const reasoningPartId = this.reasoningBlocksByIndex.get(blockIndex) ?? this.reasoningPartId
      if (!reasoningPartId) return
      this.enqueue({ type: 'reasoning-delta', id: reasoningPartId, text: event.delta.thinking })
      return
    }

    if (event.type === 'content_block_stop') {
      this.hasReceivedStreamEvents = true
      const blockIndex = typeof event.index === 'number' ? event.index : -1
      const toolId = this.toolBlocksByIndex.get(blockIndex)
      if (toolId) {
        const state = this.toolStates.get(toolId)
        if (state && !state.inputClosed) {
          const accumulatedInput = this.toolInputAccumulators.get(toolId) ?? ''
          this.enqueue({ type: 'tool-input-end', id: toolId })
          state.inputClosed = true
          state.lastSerializedInput = accumulatedInput || state.lastSerializedInput || ''
        }
        this.toolBlocksByIndex.delete(blockIndex)
        this.toolInputAccumulators.delete(toolId)
        return
      }

      const textId = this.textBlocksByIndex.get(blockIndex)
      if (textId) {
        this.enqueue({ type: 'text-end', id: textId })
        this.textBlocksByIndex.delete(blockIndex)
        if (this.textPartId === textId) this.textPartId = undefined
        return
      }

      const reasoningId = this.reasoningBlocksByIndex.get(blockIndex)
      if (reasoningId) {
        this.enqueue({ type: 'reasoning-end', id: reasoningId })
        this.reasoningBlocksByIndex.delete(blockIndex)
        if (this.reasoningPartId === reasoningId) this.reasoningPartId = undefined
      }
    }
  }

  handleAssistantMessage(message: SDKAssistantMessage, isJsonMode: boolean): void {
    if (!Array.isArray(message.message?.content)) return

    const content = message.message.content
    const sdkParentToolUseId = message.parent_tool_use_id
    interface RawToolUse {
      type: 'tool_use'
      id?: string
      name?: string
      input?: unknown
      parent_tool_use_id?: string | null
    }
    const tools = (content as unknown[])
      .filter((item): item is RawToolUse => isRecord(item) && item.type === 'tool_use')
      .map((item) => ({
        id: typeof item.id === 'string' && item.id.length > 0 ? item.id : randomUUID(),
        name: typeof item.name === 'string' && item.name.length > 0 ? item.name : 'unknown-tool',
        input: item.input,
        parentToolUseId: typeof item.parent_tool_use_id === 'string' ? item.parent_tool_use_id : null,
      }))

    if (this.textPartId && tools.length > 0) this.closeTextPart()

    for (const tool of tools) {
      const state = this.ensureToolState(tool.id, tool.name, sdkParentToolUseId ?? tool.parentToolUseId)
      if (!state.inputStarted) this.startToolInput(tool.id, state)
      const serializedInput = this.serializeToolInput(tool.input)
      if (serializedInput) this.syncToolInputSnapshot(tool.id, state, serializedInput)
      state.hasAssistantSnapshot = true
      if (this.pendingApprovalRequests.has(tool.id)) this.emitToolCall(tool.id, state)
    }

    const text = content
      .map((item: unknown) => (isRecord(item) && item.type === 'text' && typeof item.text === 'string' ? item.text : ''))
      .join('')

    if (!text) return

    if (this.hasReceivedStreamEvents) {
      this.accumulatedText = text
      if (this.textStreamedViaContentBlock && !this.textPartId) {
        this.streamedTextLength = text.length
        return
      }

      const newTextStart = this.streamedTextLength
      const deltaText = text.length > newTextStart ? text.slice(newTextStart) : ''
      if (!isJsonMode && deltaText) {
        if (!this.textPartId) {
          this.textPartId = randomUUID()
          this.enqueue({ type: 'text-start', id: this.textPartId })
        }
        this.enqueue({ type: 'text-delta', id: this.textPartId, text: deltaText })
      }
      this.streamedTextLength = text.length
      return
    }

    let deltaText = text
    if (this.accumulatedText.length > 0 && text.startsWith(this.accumulatedText)) {
      deltaText = text.slice(this.accumulatedText.length)
      this.accumulatedText = text
    } else if (this.accumulatedText.length > 0 && this.accumulatedText.startsWith(text)) {
      deltaText = ''
    } else {
      this.accumulatedText += text
    }

    if (!isJsonMode && deltaText) {
      if (!this.textPartId) {
        this.textPartId = randomUUID()
        this.enqueue({ type: 'text-start', id: this.textPartId })
      }
      this.enqueue({ type: 'text-delta', id: this.textPartId, text: deltaText })
    }
  }

  handleUserMessage(message: SDKUserMessage): void {
    const content = message.message?.content
    if (!content) return

    this.closeTextPart()

    const localCommandStdout =
      typeof content === 'string'
        ? content.trim().match(/^<local-command-stdout>([\s\S]*?)<\/local-command-stdout>$/)?.[1]
        : undefined

    if (typeof localCommandStdout === 'string' && localCommandStdout.length > 0) {
      const textId = randomUUID()
      this.enqueue({ type: 'text-start', id: textId })
      this.enqueue({ type: 'text-delta', id: textId, text: localCommandStdout })
      this.enqueue({ type: 'text-end', id: textId })
    }

    if (!Array.isArray(content)) {
      return
    }

    interface RawToolResult {
      type: 'tool_result'
      tool_use_id?: string
      content?: unknown
      is_error?: unknown
      name?: unknown
    }
    const toolResults = (content as unknown[])
      .filter((item): item is RawToolResult => isRecord(item) && item.type === 'tool_result')
      .map((item) => ({
        id:
          typeof item.tool_use_id === 'string' && item.tool_use_id.length > 0
            ? item.tool_use_id
            : randomUUID(),
        name: typeof item.name === 'string' && item.name.length > 0 ? item.name : undefined,
        result: item.content,
        isError: Boolean(item.is_error),
      }))

    for (const result of toolResults) {
      let state = this.toolStates.get(result.id)
      const toolName = result.name ?? state?.name ?? 'unknown-tool'
      if (!state) {
        state = {
          name: toolName,
          inputStarted: true,
          inputClosed: true,
          callEmitted: false,
          parentToolCallId: toolName === 'Task' ? null : (message.parent_tool_use_id ?? null),
        }
        this.toolStates.set(result.id, state)
      }
      state.name = toolName
      this.emitToolCall(result.id, state)
      const normalizedResult = this.normalizeToolResult(result.result)
      const rawResult =
        typeof result.result === 'string'
          ? result.result
          : (() => {
              try {
                return JSON.stringify(result.result)
              } catch {
                return String(result.result)
              }
            })()
      const truncatedRaw = truncateToolResultForStream(rawResult, MAX_TOOL_RESULT_SIZE) as string
      const output = truncateToolResultForStream(normalizedResult, MAX_TOOL_RESULT_SIZE)
      if (result.isError) {
        this.enqueue({
          type: 'tool-error',
          toolCallId: result.id,
          toolName,
          input: state.lastSerializedInput ?? '',
          error: new Error(truncatedRaw),
          providerExecuted: true,
          dynamic: true,
          providerMetadata: {
            'claude-code': {
              rawError: truncatedRaw,
              parentToolCallId: state.parentToolCallId ?? null,
            },
          },
        })
      } else {
        this.enqueue({
          type: 'tool-result',
          toolCallId: result.id,
          toolName,
          input: state.lastSerializedInput ?? '',
          output,
          providerExecuted: true,
          dynamic: true,
          providerMetadata: {
            'claude-code': {
              rawResult: truncatedRaw,
              rawResultTruncated: truncatedRaw !== rawResult,
              parentToolCallId: state.parentToolCallId ?? null,
            },
          },
        })
      }
    }

    interface RawToolError {
      type: 'tool_error'
      tool_use_id?: string
      error?: unknown
      name?: unknown
    }
    const toolErrors = (content as unknown[])
      .filter((item): item is RawToolError => isRecord(item) && item.type === 'tool_error')
      .map((item) => ({
        id:
          typeof item.tool_use_id === 'string' && item.tool_use_id.length > 0
            ? item.tool_use_id
            : randomUUID(),
        name: typeof item.name === 'string' && item.name.length > 0 ? item.name : undefined,
        error: item.error,
      }))

    for (const error of toolErrors) {
      let state = this.toolStates.get(error.id)
      const toolName = error.name ?? state?.name ?? 'unknown-tool'
      if (!state) {
        state = {
          name: toolName,
          inputStarted: true,
          inputClosed: true,
          callEmitted: false,
          parentToolCallId: toolName === 'Task' ? null : (message.parent_tool_use_id ?? null),
        }
        this.toolStates.set(error.id, state)
      }
      this.emitToolCall(error.id, state)
      const rawError =
        typeof error.error === 'string'
          ? error.error
          : (() => {
              try {
                return JSON.stringify(error.error)
              } catch {
                return String(error.error)
              }
            })()
      this.enqueue({
        type: 'tool-error',
        toolCallId: error.id,
        toolName,
        input: state.lastSerializedInput ?? '',
        error: new Error(rawError),
        providerExecuted: true,
        dynamic: true,
        providerMetadata: {
          'claude-code': {
            rawError,
            parentToolCallId: state.parentToolCallId ?? null,
          },
        },
      })
    }

  }

  handleSystemMessage(message: SDKSystemMessage): { sessionId?: string; initData?: Record<string, unknown> } | undefined {
    if (message.subtype === 'init') {
      return {
        sessionId: message.session_id,
        initData: {
          session_id: message.session_id,
          slash_commands: message.slash_commands ?? [],
          skills: message.skills ?? [],
          tools: message.tools ?? [],
          mcp_servers: message.mcp_servers ?? [],
          model: message.model,
          agents: message.agents,
        },
      }
    }

    if (
      message.subtype === 'local_command_output' &&
      'content' in message &&
      typeof message.content === 'string'
    ) {
      const textId = randomUUID()
      this.enqueue({ type: 'text-start', id: textId })
      this.enqueue({ type: 'text-delta', id: textId, text: message.content })
      this.enqueue({ type: 'text-end', id: textId })
    }

    return undefined
  }

  handleResult(message: SDKResultMessage, isJsonMode: boolean): void {
    if ('usage' in message && message.usage) {
      this.latestTotalUsage = toLanguageModelUsage(message.usage)
    }

    if (message.type === 'result' && message.subtype === 'success') {
      const structuredOutput = 'structured_output' in message ? message.structured_output : undefined
      const alreadyStreamedJson = this.hasStreamedJson && isJsonMode && this.hasReceivedStreamEvents

      if (alreadyStreamedJson) {
        this.closeTextPart()
      } else if (structuredOutput !== undefined) {
        const textId = randomUUID()
        this.enqueue({ type: 'text-start', id: textId })
        this.enqueue({ type: 'text-delta', id: textId, text: JSON.stringify(structuredOutput) })
        this.enqueue({ type: 'text-end', id: textId })
      } else if (this.textPartId) {
        this.closeTextPart()
      } else if (this.accumulatedText && !this.textStreamedViaContentBlock) {
        const textId = randomUUID()
        this.enqueue({ type: 'text-start', id: textId })
        this.enqueue({ type: 'text-delta', id: textId, text: this.accumulatedText })
        this.enqueue({ type: 'text-end', id: textId })
      }
    }

    const finish = mapFinishReason(message.subtype)
    const extraMetadata: JsonRecord = {
      ...(typeof message.total_cost_usd === 'number' ? { costUsd: message.total_cost_usd } : {}),
      ...(typeof message.duration_ms === 'number' ? { durationMs: message.duration_ms } : {}),
      ...(isRecord(message.modelUsage) ? { modelUsage: message.modelUsage as JsonRecord } : {}),
    }
    const providerMetadata = this.buildProviderMetadata(extraMetadata)
    const finalUsage = this.pendingStepUsage ?? this.latestTotalUsage

    this.pendingStepUsage = finalUsage
    this.emitMessageMetadata(providerMetadata, finalUsage)
    this.flushStep(finish.unified, finish.raw, extraMetadata)

    this.enqueue({
      type: 'finish',
      finishReason: finish.unified,
      rawFinishReason: finish.raw,
      totalUsage: this.latestTotalUsage ?? toLanguageModelUsage(createEmptyRawUsage()),
      ...(providerMetadata ? { providerMetadata } : {}),
    })
    this.closed = true
  }

  emitError(error: unknown): void {
    this.finalizeToolCalls()
    this.enqueue({ type: 'error', error })
    this.closed = true
  }
}
