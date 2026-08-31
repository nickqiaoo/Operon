import { randomUUID } from 'node:crypto'
import type * as acp from '@zed-industries/agent-client-protocol'
import { buildStreamMessageMetadata } from '../../stream-message-metadata.js'
import type { RuntimeStreamPart, RuntimeTextStreamPart } from '../../types.js'
import { UNMEASURED_STEP_PERFORMANCE } from '../../stream-utils.js'

type FinishReason = Extract<RuntimeTextStreamPart, { type: 'finish-step' }>['finishReason']
type RuntimeUsage = Extract<RuntimeTextStreamPart, { type: 'finish-step' }>['usage']
type RuntimeToolCall = Extract<RuntimeTextStreamPart, { type: 'tool-call' }>

type SessionUpdate = acp.SessionNotification['update']
type StopReason = acp.PromptResponse['stopReason']

/** Mirrors gemini/session.ts — providerMetadata must be plain JSON. */
interface JsonSchemaObject {
  [key: string]: JsonSchemaValue | undefined
}
type JsonSchemaValue = string | number | boolean | null | JsonSchemaObject | JsonSchemaValue[]

interface ToolState {
  toolName: string
  input: string
  inputStarted: boolean
  /** A non-empty input delta has been emitted, so we never send `{}` first. */
  deltaSent: boolean
  inputClosed: boolean
  callEmitted: boolean
  resultEmitted: boolean
}

function zeroUsage(): RuntimeUsage {
  return {
    inputTokens: 0,
    inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokens: 0,
    outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
    totalTokens: 0,
    raw: undefined,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toJsonString(value: unknown): string {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

/** Extract displayable text from a single ACP content block. */
function blockToText(block: acp.ContentBlock | undefined): string {
  if (!block) return ''
  switch (block.type) {
    case 'text':
      return block.text
    case 'image':
      return '[image]'
    case 'audio':
      return '[audio]'
    case 'resource_link':
      return block.uri
    case 'resource':
      return ''
    default:
      return ''
  }
}

/** Keys a relayed failure hides its message under. `Error` is grok's; the rest are convention. */
const RAW_ERROR_KEYS = ['Error', 'error', 'message'] as const

/**
 * The message a failed tool call actually carries, when `content` does not carry it.
 *
 * `content` is the documented place and stays first. But a provider relaying an MCP tool sends
 * the failure through `rawOutput` and leaves `content` empty — grok's node_repl does exactly
 * that, putting the whole thing, stack and all, under `output.Error`. Falling straight through
 * to "Tool execution failed" there drops the only copy of the error on the floor.
 */
function rawOutputToErrorText(rawOutput: Record<string, unknown> | undefined): string {
  if (!rawOutput) return ''
  const output = rawOutput.output
  if (typeof output === 'string' && output.trim() !== '') return output
  for (const candidate of [output, rawOutput]) {
    if (!isRecord(candidate)) continue
    for (const key of RAW_ERROR_KEYS) {
      const value = candidate[key]
      if (typeof value === 'string' && value.trim() !== '') return value
    }
  }
  return ''
}

/** Keys a relayed success hides its payload under. `OkayOutput` is grok's; the rest are convention. */
const RAW_OUTPUT_KEYS = ['OkayOutput', 'Ok', 'output', 'result', 'text'] as const

/**
 * The text a completed tool call actually carries, when `content` does not carry it.
 *
 * The success-path mirror of `rawOutputToErrorText`. grok relays a completed MCP call with
 * empty `content` and the real payload under `rawOutput.output.OkayOutput`, which left the
 * UI rendering a bare `{"output": ""}` envelope with the actual result buried inside `raw`.
 */
function rawOutputToText(rawOutput: Record<string, unknown> | undefined): string {
  if (!rawOutput) return ''
  const output = rawOutput.output
  if (typeof output === 'string' && output.trim() !== '') return output
  for (const candidate of [output, rawOutput]) {
    if (!isRecord(candidate)) continue
    for (const key of RAW_OUTPUT_KEYS) {
      const value = candidate[key]
      if (typeof value === 'string' && value.trim() !== '') return value
    }
  }
  return ''
}

/** Flatten ACP tool-call content items into a text summary. */
function toolContentToText(content: acp.ToolCallContent[] | null | undefined): string {
  if (!content || content.length === 0) return ''
  const parts: string[] = []
  for (const item of content) {
    if (!isRecord(item)) continue
    if (item.type === 'content' && isRecord(item.content)) {
      parts.push(blockToText(item.content as acp.ContentBlock))
    } else if (item.type === 'diff') {
      parts.push(toJsonString(item))
    } else {
      parts.push(toJsonString(item))
    }
  }
  return parts.filter(Boolean).join('\n')
}

/**
 * Maps a single ACP session's `session/update` notifications and permission
 * requests into the AI-SDK `RuntimeStreamPart` shapes the UI already renders,
 * mirroring the output contract of the other runtime providers.
 */
export class AcpEventMapper {
  private stepStarted = false
  private textId = randomUUID()
  private textStarted = false
  private reasoningId = randomUUID()
  private reasoningStarted = false
  private readonly toolStates = new Map<string, ToolState>()
  private currentModeId: string | undefined
  private latestUsage: RuntimeUsage = zeroUsage()
  /** Live context size from the last `session/update` that carried one. */
  private latestContextTokens: number | undefined

  constructor(
    private readonly sessionId: string,
    private readonly modelId: string,
    private readonly initialWarnings: string[],
    private readonly parseUsage?: (meta: Record<string, unknown> | undefined) => RuntimeUsage | undefined,
    private readonly parseContextTokens?: (meta: Record<string, unknown> | undefined) => number | undefined,
    /** The current model's advertised context window, when the agent reports one. */
    private readonly contextWindow?: number,
  ) {}

  getCurrentModeId(): string | undefined {
    return this.currentModeId
  }

  private buildProviderMetadata(): Extract<RuntimeTextStreamPart, { type: 'finish-step' }>['providerMetadata'] {
    const acpMeta: JsonSchemaObject = { sessionId: this.sessionId }
    if (this.currentModeId) acpMeta.modeId = this.currentModeId
    // Context occupancy — deliberately the live gauge, never the turn's usage.
    // See `parseContextTokens` in ./types.ts for why inputTokens is unusable here.
    if (this.latestContextTokens != null && this.latestContextTokens > 0) {
      const contextUsage: Record<string, number> = { promptTokens: this.latestContextTokens }
      if (this.contextWindow != null && this.contextWindow > 0) {
        contextUsage.contextWindow = this.contextWindow
        contextUsage.percentUsed = this.latestContextTokens / this.contextWindow
      }
      acpMeta.contextUsage = contextUsage
    }
    return { acp: acpMeta }
  }

  private emitMessageMetadata(parts: RuntimeStreamPart[]): void {
    const metadata: Record<string, unknown> = {
      ...buildStreamMessageMetadata({ providerMetadata: this.buildProviderMetadata(), usage: this.latestUsage }),
      sessionId: this.sessionId,
      ...(this.currentModeId ? { modeId: this.currentModeId } : {}),
    }
    parts.push({ type: 'message-metadata', metadata })
  }

  private closeOpenContent(parts: RuntimeStreamPart[]): void {
    if (this.textStarted) {
      parts.push({ type: 'text-end', id: this.textId })
      this.textStarted = false
      this.textId = randomUUID()
    }
    if (this.reasoningStarted) {
      parts.push({ type: 'reasoning-end', id: this.reasoningId })
      this.reasoningStarted = false
      this.reasoningId = randomUUID()
    }
  }

  startStep(): RuntimeStreamPart[] {
    if (this.stepStarted) return []
    this.stepStarted = true
    return [
      {
        type: 'start-step',
        request: {},
        warnings: this.initialWarnings.map((message) => ({ type: 'other' as const, message })),
      },
    ]
  }

  private appendText(parts: RuntimeStreamPart[], text: string): void {
    if (!text) return
    if (!this.textStarted) {
      parts.push({ type: 'text-start', id: this.textId })
      this.textStarted = true
    }
    parts.push({ type: 'text-delta', id: this.textId, text })
  }

  private appendReasoning(parts: RuntimeStreamPart[], text: string): void {
    if (!text) return
    if (!this.reasoningStarted) {
      parts.push({ type: 'reasoning-start', id: this.reasoningId })
      this.reasoningStarted = true
    }
    parts.push({ type: 'reasoning-delta', id: this.reasoningId, text })
  }

  private getOrCreateToolState(toolCallId: string, toolName: string): ToolState {
    const existing = this.toolStates.get(toolCallId)
    if (existing) {
      if (toolName) existing.toolName = toolName
      return existing
    }
    const created: ToolState = {
      toolName: toolName || 'tool',
      input: '',
      inputStarted: false,
      deltaSent: false,
      inputClosed: false,
      callEmitted: false,
      resultEmitted: false,
    }
    this.toolStates.set(toolCallId, created)
    return created
  }

  private ensureToolCall(
    parts: RuntimeStreamPart[],
    toolCallId: string,
    toolName: string,
    /** This event's rawInput as JSON, or undefined when it carried none. */
    input: string | undefined,
    /**
     * Close the input stream and emit the `tool-call` part.
     *
     * ACP lets an agent announce `tool_call` before it knows the arguments and
     * send them later in `tool_call_update`. Finalizing on that first, empty
     * notification froze the call at `{}` — the real arguments arrived after
     * `tool-input-end`, and the `tool-call` part had already shipped, so the UI
     * rendered "No parameters." for every grep/find that grok issued.
     */
    finalize: boolean,
  ): RuntimeToolCall {
    const state = this.getOrCreateToolState(toolCallId, toolName)
    if (input !== undefined && input !== '{}' && input !== state.input) {
      state.input = input
    }
    const finalInput = state.input || '{}'

    if (!state.inputStarted) {
      // Close any open text/reasoning before starting a new tool call. Text
      // deltas that share one id collapse into a single UI part anchored at
      // its first delta, so reusing the same id across a tool boundary would
      // pull post-tool text in front of the tool call. Splitting the id here
      // preserves the real interleaving order (text → tool → text).
      this.closeOpenContent(parts)
      parts.push({
        type: 'tool-input-start',
        id: toolCallId,
        toolName: state.toolName,
        providerExecuted: true,
        dynamic: true,
      })
      state.inputStarted = true
    }
    if (!state.deltaSent && finalInput !== '{}') {
      parts.push({ type: 'tool-input-delta', id: toolCallId, delta: finalInput })
      state.deltaSent = true
    }
    // Both of these are one-way doors, so they wait until the arguments are
    // actually known (or until the result forces our hand).
    if (finalize && !state.inputClosed) {
      if (!state.deltaSent) {
        parts.push({ type: 'tool-input-delta', id: toolCallId, delta: finalInput })
        state.deltaSent = true
      }
      parts.push({ type: 'tool-input-end', id: toolCallId })
      state.inputClosed = true
    }

    const toolCall: RuntimeToolCall = {
      type: 'tool-call',
      toolCallId,
      toolName: state.toolName,
      input: finalInput,
      providerExecuted: true,
      dynamic: true,
    }
    if (finalize && !state.callEmitted) {
      parts.push(toolCall)
      state.callEmitted = true
    }
    return toolCall
  }

  private emitToolResult(
    parts: RuntimeStreamPart[],
    toolCallId: string,
    toolName: string,
    status: acp.ToolCallStatus | null | undefined,
    content: acp.ToolCallContent[] | null | undefined,
    rawOutput: Record<string, unknown> | undefined,
  ): void {
    const state = this.getOrCreateToolState(toolCallId, toolName)
    if (state.resultEmitted) return
    if (status !== 'completed' && status !== 'failed') return

    // The result settles it: finalize with whatever arguments we ended up with.
    const toolCall = this.ensureToolCall(parts, toolCallId, toolName, undefined, true)
    const text = toolContentToText(content)

    if (status === 'failed') {
      parts.push({
        type: 'tool-error',
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        input: toolCall.input,
        error: new Error(text || rawOutputToErrorText(rawOutput) || 'Tool execution failed'),
        providerExecuted: true,
        dynamic: true,
      })
    } else {
      parts.push({
        type: 'tool-result',
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        input: toolCall.input,
        output: {
          output: text || rawOutputToText(rawOutput),
          ...(rawOutput ? { raw: rawOutput } : {}),
        },
        providerExecuted: true,
        dynamic: true,
      })
    }
    state.resultEmitted = true
  }

  handleUpdate(update: SessionUpdate, notificationMeta?: Record<string, unknown>): RuntimeStreamPart[] {
    const parts: RuntimeStreamPart[] = []
    // The context gauge rides on the notification envelope's `_meta`, not on the
    // update itself, and only some updates carry it — keep the last one seen.
    const contextTokens = this.parseContextTokens?.(notificationMeta)
    if (contextTokens != null) this.latestContextTokens = contextTokens
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.appendText(parts, blockToText(update.content))
        return parts
      case 'agent_thought_chunk':
        this.appendReasoning(parts, blockToText(update.content))
        return parts
      case 'user_message_chunk':
        return parts
      case 'tool_call': {
        const toolName = update.title || update.kind || 'tool'
        const hasInput = update.rawInput !== undefined
        this.ensureToolCall(
          parts,
          update.toolCallId,
          toolName,
          hasInput ? toJsonString(update.rawInput) : undefined,
          hasInput,
        )
        this.emitToolResult(parts, update.toolCallId, toolName, update.status, update.content, update.rawOutput)
        return parts
      }
      case 'tool_call_update': {
        const toolName = update.title || 'tool'
        if (update.rawInput !== undefined) {
          this.ensureToolCall(parts, update.toolCallId, toolName, toJsonString(update.rawInput), true)
        }
        this.emitToolResult(
          parts,
          update.toolCallId,
          toolName,
          update.status,
          update.content ?? undefined,
          update.rawOutput,
        )
        return parts
      }
      case 'current_mode_update':
        this.currentModeId = update.currentModeId
        this.emitMessageMetadata(parts)
        return parts
      case 'plan':
        parts.push({
          type: 'message-metadata',
          metadata: { sessionId: this.sessionId, plan: update.entries },
        })
        return parts
      case 'available_commands_update':
        return parts
      default:
        return parts
    }
  }

  /** Synthesize a tool-call for a permission request and emit the approval part. */
  handlePermissionRequest(approvalId: string, toolCall: acp.ToolCallUpdate): RuntimeStreamPart[] {
    const parts: RuntimeStreamPart[] = []
    const toolName = toolCall.title || toolCall.kind || 'Permission'
    const input = toJsonString(toolCall.rawInput ?? { title: toolCall.title, kind: toolCall.kind })
    const synthesized = this.ensureToolCall(parts, toolCall.toolCallId, toolName, input, true)
    parts.push({ type: 'tool-approval-request', approvalId, toolCall: synthesized })
    return parts
  }

  finalize(stopReason: StopReason | undefined, resultMeta?: Record<string, unknown>): RuntimeStreamPart[] {
    const parts: RuntimeStreamPart[] = []
    const finishReason = mapStopReason(stopReason)
    this.closeOpenContent(parts)

    // ACP carries no standard usage; agents that report it put a breakdown on the
    // prompt response's `_meta`. Parse it here (provider-specific shape) so the
    // finish-step/finish parts below carry real token counts instead of zeros.
    const parsedUsage = this.parseUsage?.(resultMeta)
    if (parsedUsage) this.latestUsage = parsedUsage

    if (this.stepStarted) {
      this.emitMessageMetadata(parts)
      parts.push({
        type: 'finish-step',
        response: { id: randomUUID(), timestamp: new Date(), modelId: this.modelId },
        usage: this.latestUsage,
        performance: UNMEASURED_STEP_PERFORMANCE,
        finishReason: finishReason.unified,
        rawFinishReason: finishReason.raw,
        providerMetadata: this.buildProviderMetadata(),
      })
      this.stepStarted = false
    }

    parts.push({
      type: 'finish',
      finishReason: finishReason.unified,
      rawFinishReason: finishReason.raw,
      totalUsage: this.latestUsage,
    })
    return parts
  }
}

function mapStopReason(stopReason: StopReason | undefined): { unified: FinishReason; raw: string | undefined } {
  switch (stopReason) {
    case 'end_turn':
      return { unified: 'stop', raw: stopReason }
    case 'max_tokens':
    case 'max_turn_requests':
      return { unified: 'length', raw: stopReason }
    case 'refusal':
      return { unified: 'content-filter', raw: stopReason }
    case 'cancelled':
      return { unified: 'stop', raw: stopReason }
    default:
      return { unified: 'stop', raw: stopReason }
  }
}
