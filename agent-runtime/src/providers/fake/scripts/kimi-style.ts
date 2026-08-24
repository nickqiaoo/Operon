import type { RuntimeStreamPart } from '../../../types.js'
import type { FakeScript } from '../index.js'

/**
 * Scripts that mimic Kimi (Moonshot) provider event sequences.
 *
 * Real shape reference: server/src/services/runtime-provider/providers/kimi/event-stream.ts
 *
 * Provider quirks reproduced here:
 *   - Provider metadata key is `kimi`, with cache breakdown
 *     (input_other / input_cache_read / input_cache_creation)
 *   - Plan display path emits text content tagged via metadata
 *   - No attachments; tool calls land via standard tool-* events
 */

function metadata(extra: Record<string, unknown> = {}): { kimi: Record<string, unknown> } {
  return {
    kimi: {
      conversation_id: 'fake-kimi-conv',
      cache: { input_other: 4, input_cache_read: 12, input_cache_creation: 0 },
      ...extra,
    },
  }
}

const USAGE = { inputTokens: 22, outputTokens: 41, totalTokens: 63 }

export const kimiTextOnly: FakeScript = async function* ({ session }) {
  const id = `kimi-text-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id, providerMetadata: metadata() } as RuntimeStreamPart
  yield { type: 'text-delta', id, text: 'Hello from Kimi (fake).' } as RuntimeStreamPart
  yield { type: 'text-end', id } as RuntimeStreamPart
  yield {
    type: 'message-metadata',
    metadata: { providerMetadata: metadata() },
  } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const kimiToolCall: FakeScript = async function* ({ session }) {
  const textId = `kimi-text-${session.turnIndex}`
  const toolId = `kimi_tool_${session.turnIndex}`

  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'Looking that up.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart

  yield {
    type: 'tool-input-start',
    id: toolId,
    toolName: 'web_search',
    providerExecuted: true,
    dynamic: false,
  } as RuntimeStreamPart
  yield { type: 'tool-input-delta', id: toolId, delta: '{"query":"kimi"}' } as RuntimeStreamPart
  yield { type: 'tool-input-end', id: toolId } as RuntimeStreamPart

  yield {
    type: 'tool-call',
    toolCallId: toolId,
    toolName: 'web_search',
    input: { query: 'kimi' },
    providerExecuted: true,
    dynamic: false,
  } as RuntimeStreamPart
  yield {
    type: 'tool-result',
    toolCallId: toolId,
    toolName: 'web_search',
    input: { query: 'kimi' },
    output: { hits: 0 },
    dynamic: false,
  } as RuntimeStreamPart

  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const kimiPermission: FakeScript = async function* ({ session }) {
  const toolId = `kimi_perm_${session.turnIndex}`

  yield { type: 'start' } as RuntimeStreamPart
  yield {
    type: 'tool-approval-request',
    approvalId: toolId,
    toolCall: {
      type: 'tool-call',
      toolCallId: toolId,
      toolName: 'execute_code',
      input: { code: 'print(1)' },
      providerExecuted: true,
      dynamic: false,
    },
  } as RuntimeStreamPart

  const decision = await session.waitForPermission(toolId)
  if (decision.type === 'deny') {
    yield {
      type: 'tool-error',
      toolCallId: toolId,
      toolName: 'execute_code',
      input: { code: 'print(1)' },
      error: decision.reason ?? 'Denied',
      dynamic: false,
    } as RuntimeStreamPart
    yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
    return
  }

  yield {
    type: 'tool-call',
    toolCallId: toolId,
    toolName: 'execute_code',
    input: { code: 'print(1)' },
    providerExecuted: true,
    dynamic: false,
  } as RuntimeStreamPart
  yield {
    type: 'tool-result',
    toolCallId: toolId,
    toolName: 'execute_code',
    input: { code: 'print(1)' },
    output: { stdout: '1\n' },
    dynamic: false,
  } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const kimiReasoning: FakeScript = async function* ({ session }) {
  const reasoningId = `kimi-reasoning-${session.turnIndex}`
  const textId = `kimi-text-${session.turnIndex}`

  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'reasoning-start', id: reasoningId } as RuntimeStreamPart
  yield { type: 'reasoning-delta', id: reasoningId, text: 'Plan: step 1 → step 2' } as RuntimeStreamPart
  yield { type: 'reasoning-end', id: reasoningId } as RuntimeStreamPart

  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'Plan executed.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart

  yield {
    type: 'message-metadata',
    metadata: {
      providerMetadata: metadata({ reasoning_tokens: 14 }),
    },
  } as RuntimeStreamPart

  yield {
    type: 'finish',
    finishReason: 'stop',
    totalUsage: { ...USAGE, reasoningTokens: 14 },
  } as RuntimeStreamPart
}

export const kimiError: FakeScript = async function* ({ session }) {
  const id = `kimi-text-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id } as RuntimeStreamPart
  yield { type: 'text-delta', id, text: 'Triggering kimi error.' } as RuntimeStreamPart
  yield { type: 'text-end', id } as RuntimeStreamPart
  yield { type: 'error', error: 'kimi_remote_error: 500' } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'error', totalUsage: USAGE } as RuntimeStreamPart
}

export const kimiMultiTurn: FakeScript = async function* ({ session }) {
  const id = `kimi-text-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id } as RuntimeStreamPart
  yield {
    type: 'text-delta',
    id,
    text: `Kimi turn ${session.turnIndex}: ${session.userMessage}`,
  } as RuntimeStreamPart
  yield { type: 'text-end', id } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}
