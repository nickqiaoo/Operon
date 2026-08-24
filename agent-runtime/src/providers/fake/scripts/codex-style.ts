import type { RuntimeStreamPart } from '../../../types.js'
import type { FakeScript } from '../index.js'

/**
 * Scripts that mimic Codex (OpenAI Agent) provider event sequences.
 *
 * Real shape reference: server/src/services/runtime-provider/providers/codex/text-stream-emitter.ts
 *
 * Provider quirks reproduced here:
 *   - Tool tracker categorises tools (commands, fileChanges, mcpTools, webSearches)
 *   - Reasoning is tracked separately with reasoningTokens in usage
 *   - Provider metadata key is `codex` and includes thread_id, rate limits
 *   - Service tier `fast` shows up in metadata when set
 */

const THREAD_ID = 'fake-codex-thread-001'

function metadata(extra: Record<string, unknown> = {}): { codex: Record<string, unknown> } {
  return {
    codex: {
      thread_id: THREAD_ID,
      rate_limits: { used_percent: 12, window_duration_mins: 60, resets_at: '2099-01-01T00:00:00Z' },
      credits: { has_credits: true, unlimited: false, balance: 1000 },
      ...extra,
    },
  }
}

const USAGE = {
  inputTokens: 30,
  outputTokens: 60,
  totalTokens: 90,
  reasoningTokens: 12,
}

export const codexTextOnly: FakeScript = async function* ({ session }) {
  const id = `codex-text-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'start-step', request: { body: { model: 'gpt-5.4' } }, warnings: [] } as RuntimeStreamPart
  yield { type: 'text-start', id, providerMetadata: metadata() } as RuntimeStreamPart
  yield { type: 'text-delta', id, text: 'Hello from ' } as RuntimeStreamPart
  yield { type: 'text-delta', id, text: 'Codex (fake).' } as RuntimeStreamPart
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

export const codexToolCall: FakeScript = async function* ({ session }) {
  const textId = `codex-text-${session.turnIndex}`
  const toolId = `call_${session.turnIndex}_shell`

  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'Running a shell command.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart

  yield {
    type: 'tool-input-start',
    id: toolId,
    toolName: 'shell',
    providerExecuted: true,
    dynamic: false,
  } as RuntimeStreamPart
  yield { type: 'tool-input-delta', id: toolId, delta: '{"command":["ls","-la"]}' } as RuntimeStreamPart
  yield { type: 'tool-input-end', id: toolId } as RuntimeStreamPart

  yield {
    type: 'tool-call',
    toolCallId: toolId,
    toolName: 'shell',
    input: { command: ['ls', '-la'] },
    providerExecuted: true,
    dynamic: false,
  } as RuntimeStreamPart
  yield {
    type: 'tool-result',
    toolCallId: toolId,
    toolName: 'shell',
    input: { command: ['ls', '-la'] },
    output: 'total 0\ndrwxr-xr-x  1 user staff 0 .',
    dynamic: false,
  } as RuntimeStreamPart

  yield {
    type: 'message-metadata',
    metadata: {
      providerMetadata: metadata({
        tool_summary: { commands: 1, fileChanges: 0, mcpTools: 0, webSearches: 0 },
      }),
    },
  } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const codexPermission: FakeScript = async function* ({ session }) {
  const textId = `codex-text-${session.turnIndex}`
  const toolId = `call_${session.turnIndex}_apply`

  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'Need to apply a file change.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart

  yield {
    type: 'tool-input-start',
    id: toolId,
    toolName: 'apply_patch',
    providerExecuted: true,
    dynamic: false,
  } as RuntimeStreamPart
  yield { type: 'tool-input-delta', id: toolId, delta: '{"patch":"*** Begin Patch\\n...\\n*** End Patch"}' } as RuntimeStreamPart
  yield { type: 'tool-input-end', id: toolId } as RuntimeStreamPart

  yield {
    type: 'tool-approval-request',
    approvalId: toolId,
    toolCall: {
      type: 'tool-call',
      toolCallId: toolId,
      toolName: 'apply_patch',
      input: { patch: '*** Begin Patch\n...\n*** End Patch' },
      providerExecuted: true,
      dynamic: false,
    },
  } as RuntimeStreamPart

  const decision = await session.waitForPermission(toolId)

  if (decision.type === 'deny') {
    yield {
      type: 'tool-error',
      toolCallId: toolId,
      toolName: 'apply_patch',
      input: { patch: '*** Begin Patch\n...\n*** End Patch' },
      error: decision.reason ?? 'Denied by user',
      dynamic: false,
    } as RuntimeStreamPart
    yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
    return
  }

  yield {
    type: 'tool-call',
    toolCallId: toolId,
    toolName: 'apply_patch',
    input: { patch: '*** Begin Patch\n...\n*** End Patch' },
    providerExecuted: true,
    dynamic: false,
  } as RuntimeStreamPart
  yield {
    type: 'tool-result',
    toolCallId: toolId,
    toolName: 'apply_patch',
    input: { patch: '*** Begin Patch\n...\n*** End Patch' },
    output: { applied: true, changedFiles: ['src/example.ts'] },
    dynamic: false,
  } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const codexReasoning: FakeScript = async function* ({ session }) {
  const reasoningId = `codex-reasoning-${session.turnIndex}`
  const textId = `codex-text-${session.turnIndex}`

  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'reasoning-start', id: reasoningId, providerMetadata: metadata() } as RuntimeStreamPart
  yield { type: 'reasoning-delta', id: reasoningId, text: 'Codex deliberating... ' } as RuntimeStreamPart
  yield { type: 'reasoning-delta', id: reasoningId, text: 'Decision reached.' } as RuntimeStreamPart
  yield { type: 'reasoning-end', id: reasoningId } as RuntimeStreamPart

  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'Final answer.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart

  yield {
    type: 'finish',
    finishReason: 'stop',
    totalUsage: { ...USAGE, reasoningTokens: 24 },
  } as RuntimeStreamPart
}

export const codexError: FakeScript = async function* ({ session }) {
  const id = `codex-text-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id } as RuntimeStreamPart
  yield { type: 'text-delta', id, text: 'Encountering an error.' } as RuntimeStreamPart
  yield { type: 'text-end', id } as RuntimeStreamPart
  yield {
    type: 'error',
    error: 'codex_session_error: connection lost',
  } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'error', totalUsage: USAGE } as RuntimeStreamPart
}

export const codexPatchDiff: FakeScript = async function* ({ session }) {
  const textId = `codex-text-${session.turnIndex}`
  const toolId = `call_${session.turnIndex}_patch`
  const patchInput = {
    changes: [
      {
        path: '/tmp/example.ts',
        diff: '@@ -1,1 +1,1 @@\n-const x = 1\n+const x = 42\n',
      },
    ],
  }

  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'Applying a patch.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart

  yield {
    type: 'tool-input-start',
    id: toolId,
    toolName: 'patch',
    providerExecuted: true,
    dynamic: false,
  } as RuntimeStreamPart
  yield { type: 'tool-input-delta', id: toolId, delta: JSON.stringify(patchInput) } as RuntimeStreamPart
  yield { type: 'tool-input-end', id: toolId } as RuntimeStreamPart

  yield {
    type: 'tool-call',
    toolCallId: toolId,
    toolName: 'patch',
    input: patchInput,
    providerExecuted: true,
    dynamic: false,
  } as RuntimeStreamPart
  yield {
    type: 'tool-result',
    toolCallId: toolId,
    toolName: 'patch',
    input: patchInput,
    output: { applied: true },
    dynamic: false,
  } as RuntimeStreamPart

  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const codexPlanSteps: FakeScript = async function* ({ session }) {
  const textId = `codex-text-${session.turnIndex}`
  const toolId = `call_${session.turnIndex}_steps`
  const steps = [
    { step: 'Read existing config', status: 'completed' },
    { step: 'Patch the bug', status: 'inProgress' },
    { step: 'Run tests', status: 'pending' },
  ]

  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'Plan steps.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart

  yield {
    type: 'tool-input-start',
    id: toolId,
    toolName: 'codex_plan_steps',
    providerExecuted: true,
    dynamic: false,
  } as RuntimeStreamPart
  yield { type: 'tool-input-delta', id: toolId, delta: JSON.stringify({ steps }) } as RuntimeStreamPart
  yield { type: 'tool-input-end', id: toolId } as RuntimeStreamPart

  yield {
    type: 'tool-call',
    toolCallId: toolId,
    toolName: 'codex_plan_steps',
    input: { steps },
    providerExecuted: true,
    dynamic: false,
  } as RuntimeStreamPart
  yield {
    type: 'tool-result',
    toolCallId: toolId,
    toolName: 'codex_plan_steps',
    input: { steps },
    output: { steps },
    dynamic: false,
  } as RuntimeStreamPart

  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const codexMultiTurn: FakeScript = async function* ({ session }) {
  const id = `codex-text-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id } as RuntimeStreamPart
  yield {
    type: 'text-delta',
    id,
    text: `[turn ${session.turnIndex}] you said: ${session.userMessage}`,
  } as RuntimeStreamPart
  yield { type: 'text-end', id } as RuntimeStreamPart
  yield {
    type: 'message-metadata',
    metadata: { providerMetadata: metadata({ turn: session.turnIndex }) },
  } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}
