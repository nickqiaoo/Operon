import type { RuntimeStreamPart } from '../../../types.js'
import type { FakeScript } from '../index.js'

/**
 * Cross-provider scenarios used by feature-level e2e specs that don't care
 * which provider style is in use.
 */

const USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }

/**
 * Long-running stream gated on permission. Useful for stop/abort tests.
 * Emits a delta, then waits for a permission that never comes. Test should
 * abort or resolve.
 */
export const blockingPermission: FakeScript = async function* ({ session }) {
  const id = 'sc-block'
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id } as RuntimeStreamPart
  yield { type: 'text-delta', id, text: 'starting…' } as RuntimeStreamPart
  yield { type: 'text-end', id } as RuntimeStreamPart

  const approvalId = 'sc-block-approval'
  yield {
    type: 'tool-input-start',
    id: approvalId,
    toolName: 'wait',
    providerExecuted: false,
    dynamic: false,
  } as RuntimeStreamPart
  yield { type: 'tool-input-delta', id: approvalId, delta: '{}' } as RuntimeStreamPart
  yield { type: 'tool-input-end', id: approvalId } as RuntimeStreamPart
  yield {
    type: 'tool-approval-request',
    approvalId,
    toolCall: {
      type: 'tool-call',
      toolCallId: approvalId,
      toolName: 'wait',
      input: {},
      providerExecuted: false,
      dynamic: false,
    },
  } as RuntimeStreamPart

  const decision = await session.waitForPermission(approvalId)

  if (decision.type === 'deny') {
    yield {
      type: 'tool-error',
      toolCallId: approvalId,
      toolName: 'wait',
      input: {},
      error: 'denied',
      dynamic: false,
    } as RuntimeStreamPart
  } else {
    yield {
      type: 'tool-call',
      toolCallId: approvalId,
      toolName: 'wait',
      input: {},
      providerExecuted: false,
      dynamic: false,
    } as RuntimeStreamPart
    yield {
      type: 'tool-result',
      toolCallId: approvalId,
      toolName: 'wait',
      input: {},
      output: 'ok',
      dynamic: false,
    } as RuntimeStreamPart
  }

  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

/**
 * Emits a tool with permission request that, on deny, ends with a
 * `tool-output-denied` event so the UI can render the denied state.
 */
export const toolOutputDenied: FakeScript = async function* ({ session }) {
  const id = `denied-${session.turnIndex}`
  const toolId = `denied-tool-${session.turnIndex}`

  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id } as RuntimeStreamPart
  yield { type: 'text-delta', id, text: 'Trying a destructive op.' } as RuntimeStreamPart
  yield { type: 'text-end', id } as RuntimeStreamPart

  yield {
    type: 'tool-input-start',
    id: toolId,
    toolName: 'DestructiveOp',
    providerExecuted: false,
    dynamic: false,
  } as RuntimeStreamPart
  yield { type: 'tool-input-delta', id: toolId, delta: '{"target":"prod"}' } as RuntimeStreamPart
  yield { type: 'tool-input-end', id: toolId } as RuntimeStreamPart
  yield {
    type: 'tool-approval-request',
    approvalId: toolId,
    toolCall: {
      type: 'tool-call',
      toolCallId: toolId,
      toolName: 'DestructiveOp',
      input: { target: 'prod' },
      providerExecuted: false,
      dynamic: false,
    },
  } as RuntimeStreamPart

  await session.waitForPermission(toolId)
  // Always emit denied regardless of decision (test simulates server-side deny).
  yield { type: 'tool-output-denied', toolCallId: toolId } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

/**
 * Emits 3 consecutive Read tool calls so segmentMessageParts groups them
 * into a single ToolCallGroup with the summary "Read 3 files".
 */
export const compactToolGroup: FakeScript = async function* ({ session }) {
  const textId = `compact-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'Reading several files.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart

  for (let i = 1; i <= 3; i += 1) {
    const toolId = `compact-read-${session.turnIndex}-${i}`
    const filePath = `/tmp/file-${i}.ts`
    yield {
      type: 'tool-input-start',
      id: toolId,
      toolName: 'Read',
      providerExecuted: false,
      dynamic: false,
    } as RuntimeStreamPart
    yield {
      type: 'tool-input-delta',
      id: toolId,
      delta: JSON.stringify({ file_path: filePath }),
    } as RuntimeStreamPart
    yield { type: 'tool-input-end', id: toolId } as RuntimeStreamPart
    yield {
      type: 'tool-call',
      toolCallId: toolId,
      toolName: 'Read',
      input: { file_path: filePath },
      providerExecuted: false,
      dynamic: false,
    } as RuntimeStreamPart
    yield {
      type: 'tool-result',
      toolCallId: toolId,
      toolName: 'Read',
      input: { file_path: filePath },
      output: `// contents of ${filePath}`,
      dynamic: false,
    } as RuntimeStreamPart
  }

  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

/** Echoes the user message verbatim — useful for attachment / mention tests. */
export const verbatimEcho: FakeScript = async function* ({ session }) {
  const id = `verbatim-${session.turnIndex}`
  yield { type: 'text-start', id } as RuntimeStreamPart
  yield {
    type: 'text-delta',
    id,
    text: `received: ${session.userMessage}`,
  } as RuntimeStreamPart
  yield { type: 'text-end', id } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

/** A long stream punctuated with delays so tests can interrupt it. */
export const longRunning: FakeScript = async function* ({ session, delay }) {
  const id = `long-${session.turnIndex}`
  yield { type: 'text-start', id } as RuntimeStreamPart
  for (let i = 1; i <= 20; i += 1) {
    await delay(100)
    yield { type: 'text-delta', id, text: `tick-${i} ` } as RuntimeStreamPart
  }
  yield { type: 'text-end', id } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}
