import type { RuntimeStreamPart, RuntimeTextStreamPart } from '../../types.js'
import { buildStreamMessageMetadata } from '../../stream-message-metadata.js'
import type {
  OpencodeLogger,
  PermissionRequestInfo,
  QuestionRequestInfo,
  StreamingUsage,
  ToolStreamState,
} from './types.js'

type FinishReason = Extract<RuntimeTextStreamPart, { type: 'finish-step' }>['finishReason']
type FinishStepUsage = Extract<RuntimeTextStreamPart, { type: 'finish-step' }>['usage']
type ToolCallPart = Extract<RuntimeTextStreamPart, { type: 'tool-call' }>
type StartStepRequest = Extract<RuntimeTextStreamPart, { type: 'start-step' }>['request']
type StartStepWarning = Extract<RuntimeTextStreamPart, { type: 'start-step' }>['warnings'][number]

export interface EventMessagePartUpdated {
  type: 'message.part.updated'
  properties: { part: Part }
}

export interface EventMessagePartDelta {
  type: 'message.part.delta'
  properties: {
    sessionID: string
    messageID: string
    partID: string
    field: string
    delta: string
  }
}

export interface EventMessageUpdated {
  type: 'message.updated'
  properties: { info: Message }
}

export interface EventSessionStatus {
  type: 'session.status'
  properties: {
    sessionID: string
    status: { type: 'idle' } | { type: 'busy' } | { type: 'retry'; attempt: number; message: string; next: number }
  }
}

export interface EventSessionIdle {
  type: 'session.idle'
  properties: { sessionID: string }
}

export interface EventSessionError {
  type: 'session.error'
  properties: {
    sessionID: string
    error: {
      name: string
      data?: { message?: string }
    }
  }
}

export interface EventSessionLifecycle {
  type: 'session.created' | 'session.updated'
  properties: {
    info?: {
      id?: string
      parentID?: string
    }
  }
}

export interface EventPermissionAsked {
  type: 'permission.asked'
  properties: PermissionRequestInfo
}

export interface EventQuestionAsked {
  type: 'question.asked'
  properties: QuestionRequestInfo
}

export type OpencodeEvent =
  | EventMessagePartUpdated
  | EventMessagePartDelta
  | EventMessageUpdated
  | EventSessionStatus
  | EventSessionIdle
  | EventSessionError
  | EventSessionLifecycle
  | EventPermissionAsked
  | EventQuestionAsked
  | { type: string; properties: unknown }

export interface TextPart {
  id: string
  sessionID: string
  messageID: string
  type: 'text'
  text: string
  synthetic?: boolean
  ignored?: boolean
}

export interface ReasoningPart {
  id: string
  sessionID: string
  messageID: string
  type: 'reasoning'
  text: string
}

export interface ToolPart {
  id: string
  sessionID: string
  messageID: string
  type: 'tool'
  callID: string
  tool: string
  state: ToolState
}

export interface StepFinishPart {
  id: string
  sessionID: string
  messageID: string
  type: 'step-finish'
  reason: string
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
}

export interface StepStartPart {
  id: string
  sessionID: string
  messageID: string
  type: 'step-start'
  snapshot?: string
}

export interface FilePart {
  id: string
  sessionID: string
  messageID: string
  type: 'file'
  mime: string
  filename?: string
  url: string
}

export type Part =
  | TextPart
  | ReasoningPart
  | ToolPart
  | StepFinishPart
  | StepStartPart
  | FilePart
  | {
      id: string
      sessionID: string
      messageID: string
      type: string
      [key: string]: unknown
    }

interface ToolStatePending {
  status: 'pending'
  input: Record<string, unknown>
  raw: string
}

interface ToolStateRunning {
  status: 'running'
  input: Record<string, unknown>
  title?: string
  metadata?: { sessionId?: string; [key: string]: unknown }
  time: { start: number }
}

interface ToolStateCompleted {
  status: 'completed'
  input: Record<string, unknown>
  output: string
  title: string
  time: { start: number; end: number }
}

interface ToolStateError {
  status: 'error'
  input: Record<string, unknown>
  error: string
  time: { start: number; end: number }
}

type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

export interface Message {
  id: string
  sessionID: string
  role: 'user' | 'assistant'
  error?: { name: string; data?: unknown }
  finish?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: {
      read?: number
      write?: number
    }
  }
}

export interface StreamState {
  stepStarted: boolean
  initialStepRequest: StartStepRequest
  initialStepWarnings: StartStepWarning[]
  modelId: string
  textPartId: string | undefined
  textStarted: boolean
  reasoningPartId: string | undefined
  reasoningStarted: boolean
  toolStates: Map<string, ToolStreamState>
  usage: StreamingUsage
  lastTextContent: string
  lastReasoningContent: string
  messageRoles: Map<string, 'user' | 'assistant'>
  partsById: Map<string, Part>
  pendingPartDeltas: Map<string, string[]>
  pendingApprovals: Map<string, { permissionId: string }>
  compacted: boolean
  latestAssistantPromptTokens: number | undefined
  latestStepPromptTokens: number | undefined
  messageUsage: StreamingUsage | undefined
  childSessions: Map<string, string>
  pendingTaskCallIds: string[]
}

export function createStreamState(params?: {
  initialStepRequest?: StartStepRequest
  initialStepWarnings?: StartStepWarning[]
  modelId?: string
}): StreamState {
  return {
    stepStarted: false,
    initialStepRequest: params?.initialStepRequest ?? {},
    initialStepWarnings: params?.initialStepWarnings ?? [],
    modelId: params?.modelId ?? '',
    textPartId: undefined,
    textStarted: false,
    reasoningPartId: undefined,
    reasoningStarted: false,
    toolStates: new Map(),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cachedWriteTokens: 0,
      totalCost: 0,
    },
    lastTextContent: '',
    lastReasoningContent: '',
    messageRoles: new Map(),
    partsById: new Map(),
    pendingPartDeltas: new Map(),
    pendingApprovals: new Map(),
    compacted: false,
    latestAssistantPromptTokens: undefined,
    latestStepPromptTokens: undefined,
    messageUsage: undefined,
    childSessions: new Map(),
    pendingTaskCallIds: [],
  }
}

function openStepIfNeeded(state: StreamState): RuntimeStreamPart[] {
  if (state.stepStarted) return []
  state.stepStarted = true
  return [{
    type: 'start-step',
    request: state.initialStepRequest,
    warnings: state.initialStepWarnings,
  }]
}

function closeOpenContent(state: StreamState): RuntimeStreamPart[] {
  const parts: RuntimeStreamPart[] = []
  if (state.textStarted && state.textPartId) {
    parts.push({ type: 'text-end', id: state.textPartId })
  }
  if (state.reasoningStarted && state.reasoningPartId) {
    parts.push({ type: 'reasoning-end', id: state.reasoningPartId })
  }
  state.textStarted = false
  state.textPartId = undefined
  state.lastTextContent = ''
  state.reasoningStarted = false
  state.reasoningPartId = undefined
  state.lastReasoningContent = ''
  return parts
}

function debugLog(logger: OpencodeLogger | false | undefined, message: string): void {
  if (logger && logger.debug) {
    logger.debug(message)
  }
}

export function isEventForSession(event: OpencodeEvent, sessionId: string): boolean {
  if (typeof event.properties !== 'object' || event.properties === null) return false
  const props = event.properties as Record<string, unknown>
  if (typeof props.sessionID === 'string') return props.sessionID === sessionId
  if (typeof props.info === 'object' && props.info !== null) {
    return (props.info as Record<string, unknown>).sessionID === sessionId
  }
  if (typeof props.part === 'object' && props.part !== null) {
    return (props.part as Record<string, unknown>).sessionID === sessionId
  }
  return false
}

export function getEventSessionId(event: OpencodeEvent): string | undefined {
  if (typeof event.properties !== 'object' || event.properties === null) return undefined
  const props = event.properties as Record<string, unknown>
  if (typeof props.sessionID === 'string') return props.sessionID
  if (typeof props.info === 'object' && props.info !== null) {
    const value = (props.info as Record<string, unknown>).sessionID
    return typeof value === 'string' ? value : undefined
  }
  if (typeof props.part === 'object' && props.part !== null) {
    const value = (props.part as Record<string, unknown>).sessionID
    return typeof value === 'string' ? value : undefined
  }
  return undefined
}

export function isSessionComplete(event: OpencodeEvent, sessionId: string): boolean {
  if (event.type === 'session.status') {
    const statusEvent = event as EventSessionStatus
    return statusEvent.properties.sessionID === sessionId && statusEvent.properties.status.type === 'idle'
  }
  if (event.type === 'session.idle') {
    return (event as EventSessionIdle).properties.sessionID === sessionId
  }
  if (event.type === 'session.error') {
    return (event as EventSessionError).properties.sessionID === sessionId
  }
  return false
}

export function mapOpencodeFinishReason(message: Message | undefined): { unified: FinishReason; raw: string | undefined } {
  if (!message) return { unified: 'other', raw: undefined }
  if (message.error?.name === 'MessageAbortedError') return { unified: 'stop', raw: message.error.name }
  if (message.error?.name === 'MessageOutputLengthError') return { unified: 'length', raw: message.error.name }
  if (message.error) return { unified: 'error', raw: message.error.name }
  const finish = message.finish?.toLowerCase()
  if (!finish) return { unified: 'stop', raw: undefined }
  if (finish === 'end_turn' || finish === 'stop' || finish === 'end') return { unified: 'stop', raw: message.finish }
  if (finish === 'max_tokens' || finish === 'length') return { unified: 'length', raw: message.finish }
  if (finish === 'tool_use' || finish === 'tool_calls') return { unified: 'tool-calls', raw: message.finish }
  if (finish === 'content_filter' || finish === 'safety') return { unified: 'content-filter', raw: message.finish }
  if (finish === 'error') return { unified: 'error', raw: message.finish }
  return { unified: 'other', raw: message.finish }
}

function buildUsage(usage: StreamingUsage): FinishStepUsage {
  return {
    inputTokens: usage.inputTokens + usage.cachedInputTokens + usage.cachedWriteTokens,
    inputTokenDetails: {
      noCacheTokens: usage.inputTokens,
      cacheReadTokens: usage.cachedInputTokens,
      cacheWriteTokens: usage.cachedWriteTokens,
    },
    outputTokens: usage.outputTokens,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: usage.reasoningTokens,
    },
    totalTokens: usage.inputTokens + usage.cachedInputTokens + usage.cachedWriteTokens + usage.outputTokens,
    raw: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      reasoning_tokens: usage.reasoningTokens,
      cache_read_input_tokens: usage.cachedInputTokens,
      cache_write_input_tokens: usage.cachedWriteTokens,
      total_cost: usage.totalCost,
    },
    reasoningTokens: usage.reasoningTokens,
    cachedInputTokens: usage.cachedInputTokens,
  }
}

function buildStepProviderMetadata(
  state: StreamState,
  sessionId: string,
): Extract<RuntimeTextStreamPart, { type: 'finish-step' }>['providerMetadata'] {
  const promptTokens =
    state.latestAssistantPromptTokens ??
    state.latestStepPromptTokens ??
    state.usage.inputTokens + state.usage.cachedInputTokens + state.usage.cachedWriteTokens

  return {
    opencode: {
      sessionId,
      cost: state.usage.totalCost,
      ...(state.compacted ? { compacted: true } : {}),
      ...(promptTokens ? { contextUsage: { promptTokens } } : {}),
    },
  }
}

function mapStepFinishReason(reason: string | undefined): { unified: FinishReason; raw: string | undefined } {
  const normalized = reason?.toLowerCase()
  if (!normalized) return { unified: 'stop', raw: reason }
  if (normalized === 'end_turn' || normalized === 'stop' || normalized === 'end') return { unified: 'stop', raw: reason }
  if (normalized === 'max_tokens' || normalized === 'length') return { unified: 'length', raw: reason }
  if (normalized === 'tool_use' || normalized === 'tool_calls') return { unified: 'tool-calls', raw: reason }
  if (normalized === 'content_filter' || normalized === 'safety') return { unified: 'content-filter', raw: reason }
  if (normalized === 'error') return { unified: 'error', raw: reason }
  return { unified: 'other', raw: reason }
}

export function convertEventToStreamParts(
  event: OpencodeEvent,
  state: StreamState,
  logger?: OpencodeLogger | false,
): RuntimeStreamPart[] {
  const parts: RuntimeStreamPart[] = []

  switch (event.type) {
    case 'message.part.updated': {
      const partEvent = event as EventMessagePartUpdated
      const part = partEvent.properties.part
      state.partsById.set(part.id, part)
      parts.push(...handlePartUpdated(part, state, logger))
      const buffered = state.pendingPartDeltas.get(part.id)
      if (buffered) {
        state.pendingPartDeltas.delete(part.id)
        for (const delta of buffered) {
          const syntheticDelta: EventMessagePartDelta = {
            type: 'message.part.delta',
            properties: {
              sessionID: part.sessionID,
              messageID: part.messageID,
              partID: part.id,
              field: 'text',
              delta,
            },
          }
          parts.push(...handlePartDelta(syntheticDelta, state, logger))
        }
      }
      break
    }
    case 'message.part.delta':
      parts.push(...handlePartDelta(event as EventMessagePartDelta, state, logger))
      break
    case 'message.updated': {
      const messageEvent = event as EventMessageUpdated
      const info = messageEvent.properties.info
      state.messageRoles.set(info.id, info.role)
      if (info.role === 'assistant' && info.tokens) {
        const input = info.tokens.input ?? 0
        const output = info.tokens.output ?? 0
        const reasoning = info.tokens.reasoning ?? 0
        const cacheRead = info.tokens.cache?.read ?? 0
        const cacheWrite = info.tokens.cache?.write ?? 0
        const promptTokens = input + cacheRead + cacheWrite
        if (promptTokens > 0) state.latestAssistantPromptTokens = promptTokens
        state.messageUsage = {
          inputTokens: input,
          outputTokens: output,
          reasoningTokens: reasoning,
          cachedInputTokens: cacheRead,
          cachedWriteTokens: cacheWrite,
          totalCost: typeof info.cost === 'number' ? info.cost : 0,
        }
      }
      break
    }
    case 'session.error':
      {
      const errorEvent = event as EventSessionError
      parts.push({
        type: 'error',
        error: new Error(errorEvent.properties.error.data?.message ?? errorEvent.properties.error.name ?? 'Unknown session error'),
      })
      break
      }
    case 'session.compacted':
      state.compacted = true
      break
    case 'permission.asked':
      parts.push(...handlePermissionAsked(event as EventPermissionAsked, state))
      break
    case 'question.asked':
      parts.push(...handleQuestionAsked(event as EventQuestionAsked, state))
      break
    default:
      debugLog(logger, `Unhandled OpenCode event: ${event.type}`)
  }

  return parts
}

export function convertChildEventToStreamParts(
  event: OpencodeEvent,
  parentCallId: string,
  state: StreamState,
  logger?: OpencodeLogger | false,
): RuntimeStreamPart[] {
  if (event.type === 'message.updated') {
    const messageEvent = event as EventMessageUpdated
    const info = messageEvent.properties.info
    state.messageRoles.set(info.id, info.role)
    return []
  }

  if (event.type !== 'message.part.updated') {
    return []
  }

  const partEvent = event as EventMessagePartUpdated
  const part = partEvent.properties.part
  const messageRole = state.messageRoles.get(part.messageID)
  if (messageRole === 'user' || part.type !== 'tool') {
    return []
  }

  const childParts = handleToolPart(part as ToolPart, state, logger)
  return childParts.map((streamPart) => {
    if (
      streamPart.type === 'tool-input-start' ||
      streamPart.type === 'tool-call' ||
      streamPart.type === 'tool-result' ||
      streamPart.type === 'tool-error'
    ) {
      return {
        ...streamPart,
        providerMetadata: {
          opencode: { parentToolCallId: parentCallId },
        },
      }
    }

    return streamPart
  })
}

export function tryRegisterChildFromSessionEvent(
  childSessionId: string,
  state: StreamState,
): string | undefined {
  if (state.childSessions.has(childSessionId)) {
    return state.childSessions.get(childSessionId)
  }

  const parentCallId = state.pendingTaskCallIds.shift()
  if (parentCallId) {
    state.childSessions.set(childSessionId, parentCallId)
    return parentCallId
  }

  const assignedParents = new Set(state.childSessions.values())
  let latestCallId: string | undefined
  for (const [callId, toolState] of state.toolStates) {
    if (
      !toolState.resultEmitted &&
      !assignedParents.has(callId) &&
      (toolState.toolName === 'task' || toolState.toolName === 'Subtask')
    ) {
      latestCallId = callId
    }
  }

  if (latestCallId) {
    state.childSessions.set(childSessionId, latestCallId)
    return latestCallId
  }

  return undefined
}

function handlePartUpdated(part: Part, state: StreamState, logger?: OpencodeLogger | false): RuntimeStreamPart[] {
  const messageRole = state.messageRoles.get(part.messageID)
  if (messageRole === 'user') return []

  switch (part.type) {
    case 'step-start':
      return openStepIfNeeded(state)
    case 'text':
      return part.synthetic || part.ignored ? [] : [...openStepIfNeeded(state), ...handleTextPart(part as TextPart, undefined, state)]
    case 'reasoning':
      return [...openStepIfNeeded(state), ...handleReasoningPart(part as ReasoningPart, undefined, state)]
    case 'tool':
      return [...openStepIfNeeded(state), ...handleToolPart(part as ToolPart, state, logger)]
    case 'step-finish':
      return handleStepFinishPart(part as StepFinishPart, state)
    case 'file':
      return []
    default:
      return []
  }
}

function handlePartDelta(
  event: EventMessagePartDelta,
  state: StreamState,
  logger?: OpencodeLogger | false,
): RuntimeStreamPart[] {
  if (event.properties.field !== 'text' || !event.properties.delta) return []
  const part = state.partsById.get(event.properties.partID)
  if (!part) {
    const pending = state.pendingPartDeltas.get(event.properties.partID) ?? []
    pending.push(event.properties.delta)
    state.pendingPartDeltas.set(event.properties.partID, pending)
    return []
  }
  if (part.type === 'text') {
    const textPart = part as TextPart
    textPart.text += event.properties.delta
    return handleTextPart(textPart, event.properties.delta, state)
  }
  if (part.type === 'reasoning') {
    const reasoningPart = part as ReasoningPart
    reasoningPart.text += event.properties.delta
    return handleReasoningPart(reasoningPart, event.properties.delta, state)
  }
  debugLog(logger, `Unsupported delta part type: ${part.type}`)
  return []
}

function handleTextPart(part: TextPart, delta: string | undefined, state: StreamState): RuntimeStreamPart[] {
  const parts: RuntimeStreamPart[] = []
  if (!state.textStarted || state.textPartId !== part.id) {
    if (state.textStarted && state.textPartId && state.textPartId !== part.id) {
      parts.push({ type: 'text-end', id: state.textPartId })
    }
    parts.push({ type: 'text-start', id: part.id })
    state.textStarted = true
    state.textPartId = part.id
    state.lastTextContent = ''
  }
  const nextDelta = delta ?? part.text.slice(state.lastTextContent.length)
  if (nextDelta) {
    parts.push({ type: 'text-delta', id: part.id, text: nextDelta })
    state.lastTextContent = part.text
  }
  return parts
}

function handleReasoningPart(part: ReasoningPart, delta: string | undefined, state: StreamState): RuntimeStreamPart[] {
  const parts: RuntimeStreamPart[] = []
  if (!state.reasoningStarted || state.reasoningPartId !== part.id) {
    if (state.reasoningStarted && state.reasoningPartId && state.reasoningPartId !== part.id) {
      parts.push({ type: 'reasoning-end', id: state.reasoningPartId })
    }
    parts.push({ type: 'reasoning-start', id: part.id })
    state.reasoningStarted = true
    state.reasoningPartId = part.id
    state.lastReasoningContent = ''
  }
  const nextDelta = delta ?? part.text.slice(state.lastReasoningContent.length)
  if (nextDelta) {
    parts.push({ type: 'reasoning-delta', id: part.id, text: nextDelta })
    state.lastReasoningContent = part.text
  }
  return parts
}

function createToolCall(callId: string, toolName: string, input: string): ToolCallPart {
  return {
    type: 'tool-call',
    toolCallId: callId,
    toolName,
    input,
    providerExecuted: true,
    dynamic: true,
  }
}

function handleToolPart(part: ToolPart, state: StreamState, logger?: OpencodeLogger | false): RuntimeStreamPart[] {
  const parts: RuntimeStreamPart[] = []
  const toolName = part.tool === 'question' ? 'AskUserQuestion' : part.tool
  let streamState = state.toolStates.get(part.callID)
  if (!streamState) {
    streamState = {
      callId: part.callID,
      toolName,
      inputStarted: false,
      inputClosed: false,
      callEmitted: false,
      resultEmitted: false,
    }
    state.toolStates.set(part.callID, streamState)
  }

  switch (part.state.status) {
    case 'pending':
      if (!streamState.inputStarted) {
        parts.push({ type: 'tool-input-start', id: part.callID, toolName, providerExecuted: true, dynamic: true })
        streamState.inputStarted = true
      }
      break
    case 'running': {
      if (!streamState.inputStarted) {
        parts.push({
          type: 'tool-input-start',
          id: part.callID,
          toolName,
          providerExecuted: true,
          dynamic: true,
          ...(part.state.title ? { title: part.state.title } : {}),
        })
        streamState.inputStarted = true
      }
      const input = JSON.stringify(part.state.input)
      if (input !== streamState.lastInput) {
        const delta = streamState.lastInput && input.startsWith(streamState.lastInput)
          ? input.slice(streamState.lastInput.length)
          : input
        if (delta) {
          parts.push({ type: 'tool-input-delta', id: part.callID, delta })
        }
        streamState.lastInput = input
      }
      const pendingApproval = state.pendingApprovals.get(part.callID)
      if (pendingApproval) {
        if (!streamState.inputClosed) {
          parts.push({ type: 'tool-input-end', id: part.callID })
          streamState.inputClosed = true
        }
        const toolCall = createToolCall(part.callID, toolName, input)
        parts.push(toolCall)
        streamState.callEmitted = true
        parts.push({ type: 'tool-approval-request', approvalId: pendingApproval.permissionId, toolCall })
        state.pendingApprovals.delete(part.callID)
      }
      if (part.state.metadata?.sessionId) {
        state.childSessions.set(part.state.metadata.sessionId, part.callID)
      } else if ((part.tool === 'task' || part.tool === 'Subtask') && !state.pendingTaskCallIds.includes(part.callID)) {
        state.pendingTaskCallIds.push(part.callID)
      }
      break
    }
    case 'completed': {
      const input = JSON.stringify(part.state.input)
      if (!streamState.inputStarted) {
        parts.push({ type: 'tool-input-start', id: part.callID, toolName, providerExecuted: true, dynamic: true })
        streamState.inputStarted = true
      }
      if (!streamState.inputClosed) {
        if (input && input !== streamState.lastInput) {
          parts.push({ type: 'tool-input-delta', id: part.callID, delta: input })
          streamState.lastInput = input
        }
        parts.push({ type: 'tool-input-end', id: part.callID })
        streamState.inputClosed = true
      }
      if (!streamState.callEmitted) {
        parts.push(createToolCall(part.callID, toolName, input))
        streamState.callEmitted = true
      }
      if (!streamState.resultEmitted) {
        parts.push({
          type: 'tool-result',
          toolCallId: part.callID,
          toolName,
          input,
          output: part.state.output ?? '',
          providerExecuted: true,
          dynamic: true,
        })
        streamState.resultEmitted = true
      }
      break
    }
    case 'error': {
      const input = JSON.stringify(part.state.input)
      if (!streamState.inputStarted) {
        parts.push({ type: 'tool-input-start', id: part.callID, toolName, providerExecuted: true, dynamic: true })
        streamState.inputStarted = true
      }
      if (!streamState.inputClosed) {
        if (input && input !== streamState.lastInput) {
          parts.push({ type: 'tool-input-delta', id: part.callID, delta: input })
          streamState.lastInput = input
        }
        parts.push({ type: 'tool-input-end', id: part.callID })
        streamState.inputClosed = true
      }
      if (!streamState.callEmitted) {
        parts.push(createToolCall(part.callID, toolName, input))
        streamState.callEmitted = true
      }
      if (!streamState.resultEmitted) {
        parts.push({
          type: 'tool-error',
          toolCallId: part.callID,
          toolName,
          input,
          error: new Error(part.state.error ?? 'Unknown error'),
          providerExecuted: true,
          dynamic: true,
        })
        streamState.resultEmitted = true
        if (logger) logger.warn(`Tool ${toolName} failed: ${part.state.error}`)
      }
      break
    }
  }

  return parts
}

function handlePermissionAsked(event: EventPermissionAsked, state: StreamState): RuntimeStreamPart[] {
  const callId = event.properties.tool?.callID
  const approvalId = event.properties.id
  if (!callId) {
    const toolCall = createToolCall(approvalId, 'Permission', '{}')
    return [{ type: 'tool-approval-request', approvalId, toolCall }]
  }
  const toolState = state.toolStates.get(callId)
  if (toolState?.resultEmitted) return []
  if (toolState?.callEmitted) {
    return [{ type: 'tool-approval-request', approvalId, toolCall: createToolCall(callId, toolState.toolName, toolState.lastInput ?? '{}') }]
  }
  if (toolState?.inputStarted && toolState.lastInput) {
    const parts: RuntimeStreamPart[] = []
    if (!toolState.inputClosed) {
      parts.push({ type: 'tool-input-end', id: callId })
      toolState.inputClosed = true
    }
    const toolCall = createToolCall(callId, toolState.toolName, toolState.lastInput)
    parts.push(toolCall, { type: 'tool-approval-request', approvalId, toolCall })
    toolState.callEmitted = true
    return parts
  }
  state.pendingApprovals.set(callId, { permissionId: approvalId })
  return []
}

function handleQuestionAsked(event: EventQuestionAsked, state: StreamState): RuntimeStreamPart[] {
  const callId = event.properties.tool?.callID
  const approvalId = event.properties.id
  if (!callId) {
    const toolCall = createToolCall(approvalId, 'AskUserQuestion', '{}')
    return [{ type: 'tool-approval-request', approvalId, toolCall }]
  }
  const toolState = state.toolStates.get(callId)
  if (toolState?.resultEmitted) return []
  if (toolState?.callEmitted) {
    return [{ type: 'tool-approval-request', approvalId, toolCall: createToolCall(callId, toolState.toolName, toolState.lastInput ?? '{}') }]
  }
  state.pendingApprovals.set(callId, { permissionId: approvalId })
  return []
}

function handleStepFinishPart(part: StepFinishPart, state: StreamState): RuntimeStreamPart[] {
  state.usage = {
    inputTokens: part.tokens.input,
    outputTokens: part.tokens.output,
    reasoningTokens: part.tokens.reasoning,
    cachedInputTokens: part.tokens.cache.read,
    cachedWriteTokens: part.tokens.cache.write,
    totalCost: part.cost,
  }
  state.latestStepPromptTokens = part.tokens.input + part.tokens.cache.read + part.tokens.cache.write
  const finishReason = mapStepFinishReason(part.reason)
  // Keep step-level metadata aligned with the current step-finish payload.
  // message.updated can carry final message totals for the whole assistant turn,
  // which is useful at stream end but too coarse for mid-stream usage updates.
  const usage = buildUsage(state.usage)
  const parts = closeOpenContent(state)
  if (state.stepStarted) {
    parts.push({
      type: 'message-metadata',
      metadata: buildStreamMessageMetadata({
        providerMetadata: buildStepProviderMetadata(state, part.sessionID),
        usage,
      }),
    })
    parts.push({
      type: 'finish-step',
      response: {
        id: part.messageID,
        timestamp: new Date(),
        modelId: state.modelId,
      },
      usage,
      finishReason: finishReason.unified,
      rawFinishReason: finishReason.raw,
      providerMetadata: buildStepProviderMetadata(state, part.sessionID),
    })
    state.stepStarted = false
  }
  return parts
}

export function createFinishParts(
  state: StreamState,
  finishReason: { unified: FinishReason; raw: string | undefined },
  sessionId: string,
  modelId: string,
): RuntimeStreamPart[] {
  const parts: RuntimeStreamPart[] = []
  const usage = buildUsage(state.messageUsage ?? state.usage)
  parts.push(...closeOpenContent(state))
  if (state.stepStarted) {
    parts.push({
      type: 'message-metadata',
      metadata: buildStreamMessageMetadata({
        providerMetadata: buildStepProviderMetadata(state, sessionId),
        usage,
      }),
    })
    parts.push({
      type: 'finish-step',
      response: {
        id: sessionId,
        timestamp: new Date(),
        modelId,
      },
      usage,
      finishReason: finishReason.unified,
      rawFinishReason: finishReason.raw,
      providerMetadata: buildStepProviderMetadata(state, sessionId),
    })
    state.stepStarted = false
  }

  parts.push({
    type: 'finish',
    finishReason: finishReason.unified,
    rawFinishReason: finishReason.raw,
    totalUsage: usage,
  })
  return parts
}
