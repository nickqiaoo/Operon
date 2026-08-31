import { randomUUID } from 'node:crypto'
import type { RuntimeStreamPart } from '../../types.js'
import { COPILOT_INTERACTIVE_TOOL_NAMES } from './config.js'
import type { CopilotJsonValue, CopilotSessionEvent } from './types.js'

/**
 * Stateful translator: Copilot SDK `SessionEvent`s -> RuntimeStreamPart stream.
 *
 * The Copilot runtime emits incremental `assistant.message_delta` /
 * `assistant.reasoning_delta` events (when `streaming: true`), a final
 * `assistant.message` / `assistant.reasoning` per block, `tool.execution_start`
 * / `tool.execution_complete` pairs, and a terminal `session.idle`
 * (or `session.error`).
 *
 * This mapper owns:
 *  - the assistant text block lifecycle (text-start/delta/end), keyed by the
 *    runtime's `messageId` so multiple messages in one turn don't merge;
 *  - the reasoning block lifecycle (reasoning-start/delta/end);
 *  - tool call/result correlation by `toolCallId`;
 *  - emitting exactly one terminal `finish` (or `error`).
 *
 * It does NOT track the session id — session.ts owns that and surfaces it as a
 * `message-metadata` part, since the SDK exposes it directly on the session.
 */
export class CopilotMessageMapper {
  // Active assistant text block (at most one open at a time).
  private textId: string | null = null
  private textMessageId: string | null = null
  private emittedText = ''

  // Active reasoning block.
  private reasoningId: string | null = null
  private reasoningKey: string | null = null
  private emittedReasoning = ''

  /** toolCallId -> tool name, so a `complete` event can label its result. */
  private readonly toolNames = new Map<string, string>()
  /** toolCallId -> serialized args, echoed back on the tool-result part. */
  private readonly toolInputs = new Map<string, string>()
  /**
   * toolCallIds for ask_user / exit_plan_mode executions, whose UI is emitted by
   * the session's interactive handlers instead. We drop the runtime's own
   * start/complete events for these so the tool isn't rendered twice.
   */
  private readonly suppressedToolCallIds = new Set<string>()
  /**
   * toolCallIds whose tool-call card was already emitted by the interactive
   * permission handler (Normal mode). We drop the runtime's DUPLICATE
   * `execution_start` for these, but still render `execution_complete` so the
   * approved action's real result lands on the same card.
   */
  private readonly gatedToolCallIds = new Set<string>()

  private finished = false

  /** Map one Copilot session event to zero or more stream parts. */
  map(event: CopilotSessionEvent): RuntimeStreamPart[] {
    switch (event.type) {
      case 'assistant.message_delta':
        return this.onMessageDelta(event.data.messageId, event.data.deltaContent)
      case 'assistant.message':
        return this.onMessage(event.data.messageId, event.data.content)
      case 'assistant.reasoning_delta':
        return this.onReasoningDelta(event.data.reasoningId, event.data.deltaContent)
      case 'assistant.reasoning':
        return this.onReasoning(event.data.reasoningId, event.data.content)
      case 'tool.execution_start':
        if (COPILOT_INTERACTIVE_TOOL_NAMES.has(event.data.toolName)) {
          // ask_user / exit_plan_mode — surfaced by the interactive handler.
          this.suppressedToolCallIds.add(event.data.toolCallId)
          return []
        }
        // Normal mode already emitted this card via the approval handler; drop
        // the duplicate start but keep the seeded name/input for `complete`.
        if (this.gatedToolCallIds.has(event.data.toolCallId)) return []
        return this.onToolStart(event.data.toolCallId, event.data.toolName, event.data.arguments)
      case 'tool.execution_complete':
        if (this.suppressedToolCallIds.delete(event.data.toolCallId)) return []
        this.gatedToolCallIds.delete(event.data.toolCallId)
        return this.onToolComplete(event)
      case 'session.usage_info':
        // Live context-window occupancy. `currentTokens`/`tokenLimit` are exact
        // (the runtime reports them), so this drives the % gauge directly — no
        // estimation. Ephemeral events, emitted as the context grows; the last
        // one wins on the frontend's metadata merge = current occupancy.
        return this.onUsageInfo(event.data.currentTokens, event.data.tokenLimit)
      case 'session.idle':
        return this.onIdle()
      case 'session.error':
        return this.onError(event.data.message)
      // user.message echo, turn_start/end, assistant.usage (per-call billing),
      // etc. carry nothing to render.
      default:
        return []
    }
  }

  /** Called when the turn ends without a terminal event (crash/send rejection). */
  finalize(error?: string): RuntimeStreamPart[] {
    if (this.finished) return []
    const parts: RuntimeStreamPart[] = []
    this.closeText(parts)
    this.closeReasoning(parts)
    if (error) parts.push({ type: 'error', error: new Error(error) } as RuntimeStreamPart)
    parts.push(this.finishPart(error ? 'error' : 'stop'))
    this.finished = true
    return parts
  }

  /**
   * Close any open assistant text/reasoning block. The session calls this before
   * an interactive handler (ask_user / exit_plan_mode) emits its approval card,
   * so the card doesn't render inside an unterminated text block.
   */
  flushOpenBlocks(): RuntimeStreamPart[] {
    const parts: RuntimeStreamPart[] = []
    this.closeReasoning(parts)
    this.closeText(parts)
    return parts
  }

  /**
   * Normal-mode approval handler calls this after emitting a tool-call card so
   * the runtime's duplicate `execution_start` is dropped while its
   * `execution_complete` still renders the real result (using the seeded
   * name/input). See the gatedToolCallIds field.
   */
  gateApprovedTool(toolCallId: string, toolName: string, input: string): void {
    this.toolNames.set(toolCallId, toolName)
    this.toolInputs.set(toolCallId, input)
    this.gatedToolCallIds.add(toolCallId)
  }

  /** Stop gating a tool (on denial — no runtime completion will arrive). */
  ungateTool(toolCallId: string): void {
    this.gatedToolCallIds.delete(toolCallId)
  }

  // --- assistant text -------------------------------------------------------

  private onMessageDelta(messageId: string, deltaContent: string): RuntimeStreamPart[] {
    if (!deltaContent) return []
    const parts: RuntimeStreamPart[] = []
    this.ensureTextBlock(messageId, parts)
    this.emittedText += deltaContent
    parts.push({ type: 'text-delta', id: this.textId!, text: deltaContent } as RuntimeStreamPart)
    return parts
  }

  private onMessage(messageId: string, content: string): RuntimeStreamPart[] {
    const parts: RuntimeStreamPart[] = []
    if (content) {
      this.ensureTextBlock(messageId, parts)
      // Emit only the suffix not already streamed via deltas. When streaming
      // produced nothing (deltas disabled or diverged), emit the full content.
      const suffix = content.startsWith(this.emittedText) ? content.slice(this.emittedText.length) : content
      if (suffix) {
        this.emittedText += suffix
        parts.push({ type: 'text-delta', id: this.textId!, text: suffix } as RuntimeStreamPart)
      }
    }
    this.closeText(parts)
    return parts
  }

  private ensureTextBlock(messageId: string, out: RuntimeStreamPart[]): void {
    if (this.textId && this.textMessageId !== messageId) this.closeText(out)
    if (!this.textId) {
      this.textId = randomUUID()
      this.textMessageId = messageId
      this.emittedText = ''
      out.push({ type: 'text-start', id: this.textId } as RuntimeStreamPart)
    }
  }

  private closeText(out: RuntimeStreamPart[]): void {
    if (!this.textId) return
    out.push({ type: 'text-end', id: this.textId } as RuntimeStreamPart)
    this.textId = null
    this.textMessageId = null
    this.emittedText = ''
  }

  // --- reasoning ------------------------------------------------------------

  private onReasoningDelta(reasoningId: string, deltaContent: string): RuntimeStreamPart[] {
    if (!deltaContent) return []
    const parts: RuntimeStreamPart[] = []
    this.ensureReasoningBlock(reasoningId, parts)
    this.emittedReasoning += deltaContent
    parts.push({ type: 'reasoning-delta', id: this.reasoningId!, text: deltaContent } as RuntimeStreamPart)
    return parts
  }

  private onReasoning(reasoningId: string, content: string): RuntimeStreamPart[] {
    const parts: RuntimeStreamPart[] = []
    if (content) {
      this.ensureReasoningBlock(reasoningId, parts)
      const suffix = content.startsWith(this.emittedReasoning) ? content.slice(this.emittedReasoning.length) : content
      if (suffix) {
        this.emittedReasoning += suffix
        parts.push({ type: 'reasoning-delta', id: this.reasoningId!, text: suffix } as RuntimeStreamPart)
      }
    }
    this.closeReasoning(parts)
    return parts
  }

  private ensureReasoningBlock(reasoningKey: string, out: RuntimeStreamPart[]): void {
    if (this.reasoningId && this.reasoningKey !== reasoningKey) this.closeReasoning(out)
    if (!this.reasoningId) {
      this.reasoningId = randomUUID()
      this.reasoningKey = reasoningKey
      this.emittedReasoning = ''
      out.push({ type: 'reasoning-start', id: this.reasoningId } as RuntimeStreamPart)
    }
  }

  private closeReasoning(out: RuntimeStreamPart[]): void {
    if (!this.reasoningId) return
    out.push({ type: 'reasoning-end', id: this.reasoningId } as RuntimeStreamPart)
    this.reasoningId = null
    this.reasoningKey = null
    this.emittedReasoning = ''
  }

  // --- tools ----------------------------------------------------------------

  private onToolStart(
    toolCallId: string,
    toolName: string,
    args: CopilotJsonValue | undefined,
  ): RuntimeStreamPart[] {
    const parts: RuntimeStreamPart[] = []
    // A tool call ends any open assistant text/reasoning block first.
    this.closeReasoning(parts)
    this.closeText(parts)
    const input = JSON.stringify(args ?? {})
    this.toolNames.set(toolCallId, toolName)
    this.toolInputs.set(toolCallId, input)
    parts.push({ type: 'tool-input-start', id: toolCallId, toolName, providerExecuted: true } as RuntimeStreamPart)
    parts.push({
      type: 'tool-call',
      toolCallId,
      toolName,
      input,
      providerExecuted: true,
    } as RuntimeStreamPart)
    return parts
  }

  private onToolComplete(event: Extract<CopilotSessionEvent, { type: 'tool.execution_complete' }>): RuntimeStreamPart[] {
    const { toolCallId, success, result, error } = event.data
    const toolName = this.toolNames.get(toolCallId) ?? 'tool'
    const input = this.toolInputs.get(toolCallId) ?? '{}'
    const output: unknown = success
      ? (result?.detailedContent ?? result?.content ?? result ?? {})
      : { error: error?.message ?? 'Tool execution failed' }
    return [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        input,
        output,
        providerExecuted: true,
      } as RuntimeStreamPart,
    ]
  }

  // --- context usage --------------------------------------------------------

  /**
   * Surface the runtime's context-window occupancy as `contextUsage`
   * message-metadata (the same shape the ACP/framework paths emit, read by the
   * frontend's context gauge). Unlike cursor's ACP — which never reports live
   * tokens — the Copilot runtime gives both the current count and the model's
   * window, so `percentUsed` is exact.
   */
  private onUsageInfo(currentTokens: number, tokenLimit: number): RuntimeStreamPart[] {
    if (!(currentTokens > 0)) return []
    const contextUsage: Record<string, number> = { promptTokens: currentTokens }
    if (tokenLimit > 0) {
      contextUsage.contextWindow = tokenLimit
      contextUsage.percentUsed = currentTokens / tokenLimit
    }
    return [{ type: 'message-metadata', metadata: { contextUsage } } as RuntimeStreamPart]
  }

  // --- terminal -------------------------------------------------------------

  private onIdle(): RuntimeStreamPart[] {
    if (this.finished) return []
    const parts: RuntimeStreamPart[] = []
    this.closeReasoning(parts)
    this.closeText(parts)
    parts.push(this.finishPart('stop'))
    this.finished = true
    return parts
  }

  private onError(message: string): RuntimeStreamPart[] {
    if (this.finished) return []
    const parts: RuntimeStreamPart[] = []
    this.closeReasoning(parts)
    this.closeText(parts)
    parts.push({ type: 'error', error: new Error(message || 'Copilot session error') } as RuntimeStreamPart)
    parts.push(this.finishPart('error'))
    this.finished = true
    return parts
  }

  private finishPart(reason: 'stop' | 'error'): RuntimeStreamPart {
    return {
      type: 'finish',
      finishReason: reason,
      totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    } as RuntimeStreamPart
  }
}
