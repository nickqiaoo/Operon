import type { RuntimeStreamPart } from '../../../types.js'
import type { FakeScript } from '../index.js'

/**
 * Scripts that mimic OpenCode provider event sequences.
 *
 * Real shape reference: server/src/services/runtime-provider/providers/opencode/event-stream.ts
 *
 * Provider quirks reproduced here:
 *   - Tool state machine: tools transition idle → running → completed/failed
 *   - Provider metadata key is `opencode`, includes session id
 *   - Permission/question requests are structured (we use the standard
 *     tool-approval-request shape for simplicity)
 */

const SESSION_ID = 'fake-opencode-session-001'

function metadata(extra: Record<string, unknown> = {}): { opencode: Record<string, unknown> } {
  return { opencode: { sessionId: SESSION_ID, model: 'opencode/big-pickle', ...extra } }
}

const USAGE = { inputTokens: 16, outputTokens: 33, totalTokens: 49 }

export const opencodeTextOnly: FakeScript = async function* ({ session }) {
  const id = `oc-text-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id, providerMetadata: metadata() } as RuntimeStreamPart
  yield { type: 'text-delta', id, text: 'Hello from OpenCode (fake).' } as RuntimeStreamPart
  yield { type: 'text-end', id } as RuntimeStreamPart
  yield {
    type: 'message-metadata',
    metadata: { providerMetadata: metadata() },
  } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const opencodeToolCall: FakeScript = async function* ({ session }) {
  const textId = `oc-text-${session.turnIndex}`
  const toolId = `oc_tool_${session.turnIndex}`

  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'Reading via opencode.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart

  yield {
    type: 'tool-input-start',
    id: toolId,
    toolName: 'read',
    providerExecuted: false,
    dynamic: false,
    providerMetadata: metadata({ tool_state: 'idle' }),
  } as RuntimeStreamPart
  yield { type: 'tool-input-delta', id: toolId, delta: '{"path":"a.txt"}' } as RuntimeStreamPart
  yield { type: 'tool-input-end', id: toolId } as RuntimeStreamPart

  yield {
    type: 'tool-call',
    toolCallId: toolId,
    toolName: 'read',
    input: { path: 'a.txt' },
    providerExecuted: false,
    dynamic: false,
    providerMetadata: metadata({ tool_state: 'running' }),
  } as RuntimeStreamPart
  yield {
    type: 'tool-result',
    toolCallId: toolId,
    toolName: 'read',
    input: { path: 'a.txt' },
    output: 'opencode read result',
    dynamic: false,
    providerMetadata: metadata({ tool_state: 'completed' }),
  } as RuntimeStreamPart

  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const opencodePermission: FakeScript = async function* ({ session }) {
  const toolId = `oc_perm_${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield {
    type: 'tool-approval-request',
    approvalId: toolId,
    toolCall: {
      type: 'tool-call',
      toolCallId: toolId,
      toolName: 'edit',
      input: { path: 'a.txt', diff: '@@\n-x\n+y' },
      providerExecuted: false,
      dynamic: false,
    },
  } as RuntimeStreamPart

  const decision = await session.waitForPermission(toolId)
  if (decision.type === 'deny') {
    yield {
      type: 'tool-error',
      toolCallId: toolId,
      toolName: 'edit',
      input: { path: 'a.txt', diff: '@@\n-x\n+y' },
      error: decision.reason ?? 'Denied',
      dynamic: false,
      providerMetadata: metadata({ tool_state: 'failed' }),
    } as RuntimeStreamPart
    yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
    return
  }

  yield {
    type: 'tool-call',
    toolCallId: toolId,
    toolName: 'edit',
    input: { path: 'a.txt', diff: '@@\n-x\n+y' },
    providerExecuted: false,
    dynamic: false,
    providerMetadata: metadata({ tool_state: 'running' }),
  } as RuntimeStreamPart
  yield {
    type: 'tool-result',
    toolCallId: toolId,
    toolName: 'edit',
    input: { path: 'a.txt', diff: '@@\n-x\n+y' },
    output: { applied: true },
    dynamic: false,
    providerMetadata: metadata({ tool_state: 'completed' }),
  } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const opencodeReasoning: FakeScript = async function* ({ session }) {
  const reasoningId = `oc-reasoning-${session.turnIndex}`
  const textId = `oc-text-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'reasoning-start', id: reasoningId } as RuntimeStreamPart
  yield { type: 'reasoning-delta', id: reasoningId, text: 'opencode reasoning' } as RuntimeStreamPart
  yield { type: 'reasoning-end', id: reasoningId } as RuntimeStreamPart
  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'OK.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const opencodeError: FakeScript = async function* ({ session }) {
  const id = `oc-text-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id } as RuntimeStreamPart
  yield { type: 'text-delta', id, text: 'opencode failure incoming.' } as RuntimeStreamPart
  yield { type: 'text-end', id } as RuntimeStreamPart
  yield { type: 'error', error: 'opencode_session_error: refused' } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'error', totalUsage: USAGE } as RuntimeStreamPart
}

export const opencodeTodoWrite: FakeScript = async function* ({ session }) {
  const textId = `oc-text-${session.turnIndex}`
  const toolId = `oc_${session.turnIndex}_todo`
  const todos = [
    { content: 'Read the failing test', activeForm: 'Reading the failing test', status: 'completed' },
    { content: 'Patch the bug', activeForm: 'Patching the bug', status: 'in_progress' },
    { content: 'Add regression test', activeForm: 'Adding regression test', status: 'pending' },
  ]

  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'Tracking progress.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart

  yield {
    type: 'tool-input-start',
    id: toolId,
    toolName: 'todowrite',
    providerExecuted: false,
    dynamic: false,
  } as RuntimeStreamPart
  yield { type: 'tool-input-delta', id: toolId, delta: JSON.stringify({ todos }) } as RuntimeStreamPart
  yield { type: 'tool-input-end', id: toolId } as RuntimeStreamPart

  yield {
    type: 'tool-call',
    toolCallId: toolId,
    toolName: 'todowrite',
    input: { todos },
    providerExecuted: false,
    dynamic: false,
  } as RuntimeStreamPart
  yield {
    type: 'tool-result',
    toolCallId: toolId,
    toolName: 'todowrite',
    input: { todos },
    output: { saved: true },
    dynamic: false,
  } as RuntimeStreamPart

  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const opencodeMultiTurn: FakeScript = async function* ({ session }) {
  const id = `oc-text-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id } as RuntimeStreamPart
  yield {
    type: 'text-delta',
    id,
    text: `Opencode turn ${session.turnIndex}: ${session.userMessage}`,
  } as RuntimeStreamPart
  yield { type: 'text-end', id } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}
