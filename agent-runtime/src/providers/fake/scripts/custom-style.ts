import type { RuntimeStreamPart } from '../../../types.js'
import type { FakeScript } from '../index.js'

/**
 * Scripts that mimic the Custom (Vercel AI SDK) provider.
 *
 * Real shape reference: server/src/services/runtime-provider/providers/custom.ts
 *
 * Provider quirks reproduced here:
 *   - Events come straight from `streamText().fullStream`
 *   - No warm session; metadata key `custom` carries provider/model
 *   - Up to 40 agentic steps; finish-step events between turns
 */

function metadata(provider: string, model: string, extra: Record<string, unknown> = {}): {
  custom: Record<string, unknown>
} {
  return { custom: { provider, model, ...extra } }
}

const USAGE = { inputTokens: 14, outputTokens: 28, totalTokens: 42 }

export const customTextOnly: FakeScript = async function* ({ session }) {
  const id = `custom-text-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield {
    type: 'start-step',
    request: {},
    warnings: [],
  } as RuntimeStreamPart
  yield {
    type: 'text-start',
    id,
    providerMetadata: metadata('anthropic', 'claude-3-5-sonnet'),
  } as RuntimeStreamPart
  yield { type: 'text-delta', id, text: 'Hello from Custom (fake).' } as RuntimeStreamPart
  yield { type: 'text-end', id } as RuntimeStreamPart
  yield {
    type: 'finish-step',
    finishReason: 'stop',
    usage: USAGE,
    response: {},
  } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const customToolCall: FakeScript = async function* ({ session }) {
  const textId = `custom-text-${session.turnIndex}`
  const toolId = `custom_tool_${session.turnIndex}`

  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'start-step', request: {}, warnings: [] } as RuntimeStreamPart
  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'Calling a tool.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart

  yield {
    type: 'tool-input-start',
    id: toolId,
    toolName: 'getWeather',
    providerExecuted: false,
    dynamic: false,
  } as RuntimeStreamPart
  yield { type: 'tool-input-delta', id: toolId, delta: '{"city":"Beijing"}' } as RuntimeStreamPart
  yield { type: 'tool-input-end', id: toolId } as RuntimeStreamPart

  yield {
    type: 'tool-call',
    toolCallId: toolId,
    toolName: 'getWeather',
    input: { city: 'Beijing' },
    providerExecuted: false,
    dynamic: false,
  } as RuntimeStreamPart
  yield {
    type: 'tool-result',
    toolCallId: toolId,
    toolName: 'getWeather',
    input: { city: 'Beijing' },
    output: { temp: 20, condition: 'sunny' },
    dynamic: false,
  } as RuntimeStreamPart

  yield {
    type: 'finish-step',
    finishReason: 'tool-calls',
    usage: USAGE,
    response: {},
  } as RuntimeStreamPart

  // Second step: model uses the tool result.
  const followupId = `custom-text-${session.turnIndex}-2`
  yield { type: 'start-step', request: {}, warnings: [] } as RuntimeStreamPart
  yield { type: 'text-start', id: followupId } as RuntimeStreamPart
  yield {
    type: 'text-delta',
    id: followupId,
    text: 'It is 20°C and sunny in Beijing.',
  } as RuntimeStreamPart
  yield { type: 'text-end', id: followupId } as RuntimeStreamPart
  yield {
    type: 'finish-step',
    finishReason: 'stop',
    usage: USAGE,
    response: {},
  } as RuntimeStreamPart

  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const customPermission: FakeScript = async function* ({ session }) {
  const toolId = `custom_perm_${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield {
    type: 'tool-approval-request',
    approvalId: toolId,
    toolCall: {
      type: 'tool-call',
      toolCallId: toolId,
      toolName: 'sendEmail',
      input: { to: 'a@b.com', subject: 'hi' },
      providerExecuted: false,
      dynamic: false,
    },
  } as RuntimeStreamPart

  const decision = await session.waitForPermission(toolId)
  if (decision.type === 'deny') {
    yield {
      type: 'tool-error',
      toolCallId: toolId,
      toolName: 'sendEmail',
      input: { to: 'a@b.com', subject: 'hi' },
      error: decision.reason ?? 'Denied',
      dynamic: false,
    } as RuntimeStreamPart
    yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
    return
  }

  yield {
    type: 'tool-call',
    toolCallId: toolId,
    toolName: 'sendEmail',
    input: { to: 'a@b.com', subject: 'hi' },
    providerExecuted: false,
    dynamic: false,
  } as RuntimeStreamPart
  yield {
    type: 'tool-result',
    toolCallId: toolId,
    toolName: 'sendEmail',
    input: { to: 'a@b.com', subject: 'hi' },
    output: { sent: true },
    dynamic: false,
  } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const customReasoning: FakeScript = async function* ({ session }) {
  const reasoningId = `custom-reasoning-${session.turnIndex}`
  const textId = `custom-text-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'reasoning-start', id: reasoningId } as RuntimeStreamPart
  yield { type: 'reasoning-delta', id: reasoningId, text: 'Custom thinking…' } as RuntimeStreamPart
  yield { type: 'reasoning-end', id: reasoningId } as RuntimeStreamPart
  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'Done.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const customError: FakeScript = async function* ({ session }) {
  const id = `custom-text-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id } as RuntimeStreamPart
  yield { type: 'text-delta', id, text: 'Custom about to fail.' } as RuntimeStreamPart
  yield { type: 'text-end', id } as RuntimeStreamPart
  yield { type: 'error', error: 'custom_provider_error: timeout' } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'error', totalUsage: USAGE } as RuntimeStreamPart
}

export const customMultiTurn: FakeScript = async function* ({ session }) {
  const id = `custom-text-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id } as RuntimeStreamPart
  yield {
    type: 'text-delta',
    id,
    text: `Custom turn ${session.turnIndex}: ${session.userMessage}`,
  } as RuntimeStreamPart
  yield { type: 'text-end', id } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}
