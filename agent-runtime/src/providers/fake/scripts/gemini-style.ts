import type { RuntimeStreamPart } from '../../../types.js'
import type { FakeScript } from '../index.js'

/**
 * Scripts that mimic Gemini CLI provider event sequences.
 *
 * Real shape reference: server/src/services/runtime-provider/providers/gemini/session.ts
 *
 * Provider quirks reproduced here:
 *   - Uses the same SDK as Claude Code, so events look very similar
 *   - Provider metadata key is `gemini`, includes session/model
 *   - No checkpoint support
 */

const SESSION_ID = 'fake-gemini-session-001'

function metadata(extra: Record<string, unknown> = {}): { gemini: Record<string, unknown> } {
  return { gemini: { sessionId: SESSION_ID, model: 'gemini-2.5-pro', ...extra } }
}

const USAGE = { inputTokens: 18, outputTokens: 36, totalTokens: 54 }

export const geminiTextOnly: FakeScript = async function* ({ session }) {
  const id = `gemini-text-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'start-step', request: {}, warnings: [] } as RuntimeStreamPart
  yield { type: 'text-start', id, providerMetadata: metadata() } as RuntimeStreamPart
  yield { type: 'text-delta', id, text: 'Hello from Gemini (fake).' } as RuntimeStreamPart
  yield { type: 'text-end', id } as RuntimeStreamPart
  yield {
    type: 'message-metadata',
    metadata: { providerMetadata: metadata() },
  } as RuntimeStreamPart
  yield {
    type: 'finish-step',
    finishReason: 'stop',
    usage: USAGE,
    response: {},
  } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const geminiToolCall: FakeScript = async function* ({ session }) {
  const textId = `gemini-text-${session.turnIndex}`
  const toolId = `gem_tool_${session.turnIndex}`

  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'Searching the web.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart

  yield {
    type: 'tool-input-start',
    id: toolId,
    toolName: 'GoogleSearch',
    providerExecuted: true,
    dynamic: false,
  } as RuntimeStreamPart
  yield { type: 'tool-input-delta', id: toolId, delta: '{"query":"fake runtime"}' } as RuntimeStreamPart
  yield { type: 'tool-input-end', id: toolId } as RuntimeStreamPart

  yield {
    type: 'tool-call',
    toolCallId: toolId,
    toolName: 'GoogleSearch',
    input: { query: 'fake runtime' },
    providerExecuted: true,
    dynamic: false,
  } as RuntimeStreamPart
  yield {
    type: 'tool-result',
    toolCallId: toolId,
    toolName: 'GoogleSearch',
    input: { query: 'fake runtime' },
    output: { results: [{ title: 'Result 1', snippet: 'Fake result.' }] },
    dynamic: false,
  } as RuntimeStreamPart

  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const geminiPermission: FakeScript = async function* ({ session }) {
  const toolId = `gem_perm_${session.turnIndex}`

  yield { type: 'start' } as RuntimeStreamPart
  yield {
    type: 'tool-approval-request',
    approvalId: toolId,
    toolCall: {
      type: 'tool-call',
      toolCallId: toolId,
      toolName: 'WriteFile',
      input: { path: '/tmp/out.txt', content: 'hello' },
      providerExecuted: false,
      dynamic: false,
    },
  } as RuntimeStreamPart

  const decision = await session.waitForPermission(toolId)

  if (decision.type === 'deny') {
    yield {
      type: 'tool-error',
      toolCallId: toolId,
      toolName: 'WriteFile',
      input: { path: '/tmp/out.txt', content: 'hello' },
      error: decision.reason ?? 'Permission denied',
      dynamic: false,
    } as RuntimeStreamPart
    yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
    return
  }

  yield {
    type: 'tool-call',
    toolCallId: toolId,
    toolName: 'WriteFile',
    input: { path: '/tmp/out.txt', content: 'hello' },
    providerExecuted: false,
    dynamic: false,
  } as RuntimeStreamPart
  yield {
    type: 'tool-result',
    toolCallId: toolId,
    toolName: 'WriteFile',
    input: { path: '/tmp/out.txt', content: 'hello' },
    output: { written: true },
    dynamic: false,
  } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const geminiPlan: FakeScript = async function* ({ session }) {
  const textId = `gemini-text-${session.turnIndex}`
  const toolId = `gemini-plan-${session.turnIndex}`
  const planMarkdown = '# Migration plan\n- Step 1: snapshot DB\n- Step 2: run migration\n- Step 3: verify'

  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'Drafted a plan.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart

  yield {
    type: 'tool-input-start',
    id: toolId,
    toolName: 'exit_plan_mode',
    providerExecuted: false,
    dynamic: false,
  } as RuntimeStreamPart
  yield {
    type: 'tool-input-delta',
    id: toolId,
    delta: JSON.stringify({ plan: planMarkdown }),
  } as RuntimeStreamPart
  yield { type: 'tool-input-end', id: toolId } as RuntimeStreamPart

  yield {
    type: 'tool-approval-request',
    approvalId: toolId,
    toolCall: {
      type: 'tool-call',
      toolCallId: toolId,
      toolName: 'exit_plan_mode',
      input: { plan: planMarkdown },
      providerExecuted: false,
      dynamic: false,
    },
  } as RuntimeStreamPart

  const decision = await session.waitForPermission(toolId)

  if (decision.type === 'deny') {
    yield {
      type: 'tool-error',
      toolCallId: toolId,
      toolName: 'exit_plan_mode',
      input: { plan: planMarkdown },
      error: decision.reason ?? 'Plan rejected',
      dynamic: false,
    } as RuntimeStreamPart
    yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
    return
  }

  yield {
    type: 'tool-call',
    toolCallId: toolId,
    toolName: 'exit_plan_mode',
    input: { plan: planMarkdown },
    providerExecuted: false,
    dynamic: false,
  } as RuntimeStreamPart
  yield {
    type: 'tool-result',
    toolCallId: toolId,
    toolName: 'exit_plan_mode',
    input: { plan: planMarkdown },
    output: { approved: true, mode: (decision.updatedInput as { approvalMode?: string } | undefined)?.approvalMode ?? 'default' },
    dynamic: false,
  } as RuntimeStreamPart

  const closingId = `gemini-text-${session.turnIndex}-end`
  yield { type: 'text-start', id: closingId } as RuntimeStreamPart
  yield { type: 'text-delta', id: closingId, text: 'Implementing the plan now.' } as RuntimeStreamPart
  yield { type: 'text-end', id: closingId } as RuntimeStreamPart

  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const geminiReasoning: FakeScript = async function* ({ session }) {
  const reasoningId = `gemini-reasoning-${session.turnIndex}`
  const textId = `gemini-text-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'reasoning-start', id: reasoningId } as RuntimeStreamPart
  yield { type: 'reasoning-delta', id: reasoningId, text: 'Gemini reasoning step' } as RuntimeStreamPart
  yield { type: 'reasoning-end', id: reasoningId } as RuntimeStreamPart
  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'Result.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const geminiError: FakeScript = async function* ({ session }) {
  const id = `gemini-text-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id } as RuntimeStreamPart
  yield { type: 'text-delta', id, text: 'Hitting Gemini error.' } as RuntimeStreamPart
  yield { type: 'text-end', id } as RuntimeStreamPart
  yield { type: 'error', error: 'gemini_quota_exceeded' } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'error', totalUsage: USAGE } as RuntimeStreamPart
}

export const geminiMultiTurn: FakeScript = async function* ({ session }) {
  const id = `gemini-text-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id } as RuntimeStreamPart
  yield {
    type: 'text-delta',
    id,
    text: `Gemini turn ${session.turnIndex}: ${session.userMessage}`,
  } as RuntimeStreamPart
  yield { type: 'text-end', id } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}
