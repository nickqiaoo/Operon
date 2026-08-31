import type { RuntimeStreamPart } from '../../../types.js'
import type { FakeScript } from '../index.js'

/**
 * Scripts that mimic Claude Code provider event sequences.
 *
 * Real shape reference: server/src/services/runtime-provider/providers/claude/text-stream-builder.ts
 *
 * Provider quirks reproduced here:
 *   - Wraps the stream in start → start-step → ... → finish-step → finish
 *   - Emits message-metadata with `claude-code` provider key (sessionId, cache stats)
 *   - Tool calls go through tool-input-start/delta/end → tool-call → tool-result
 *   - Permission requests emit tool-approval-request and pause until resolved
 *   - Reasoning is emitted as reasoning-start/delta/end
 */

const SESSION_ID = 'fake-claude-session-001'

function metadata(extra: Record<string, unknown> = {}): { 'claude-code': Record<string, unknown> } {
  return { 'claude-code': { sessionId: SESSION_ID, ...extra } }
}

const USAGE = {
  inputTokens: 12,
  inputTokenDetails: { noCacheTokens: 4, cacheReadTokens: 8, cacheWriteTokens: 0 },
  outputTokens: 24,
  totalTokens: 36,
}

export const claudeTextOnly: FakeScript = async function* ({ session }) {
  const id = `claude-text-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'start-step', request: { body: { model: 'claude-3-5-sonnet' } }, warnings: [] } as RuntimeStreamPart
  yield { type: 'text-start', id, providerMetadata: metadata() } as RuntimeStreamPart
  yield { type: 'text-delta', id, text: 'Hello from ' } as RuntimeStreamPart
  yield { type: 'text-delta', id, text: 'Claude (fake).' } as RuntimeStreamPart
  yield { type: 'text-end', id } as RuntimeStreamPart
  yield {
    type: 'message-metadata',
    metadata: {
      providerMetadata: metadata({
        cache_read_input_tokens: 8,
        cache_creation_input_tokens: 2,
      }),
    },
  } as RuntimeStreamPart
  yield {
    type: 'finish-step',
    finishReason: 'stop',
    usage: USAGE,
    response: { id: `msg-${session.turnIndex}` },
  } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const claudeToolCall: FakeScript = async function* ({ session }) {
  const textId = `claude-text-${session.turnIndex}`
  const toolId = `toolu_${session.turnIndex}_01`

  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'start-step', request: {}, warnings: [] } as RuntimeStreamPart

  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'Reading the file now.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart

  yield {
    type: 'tool-input-start',
    id: toolId,
    toolName: 'Read',
    providerExecuted: false,
    dynamic: false,
  } as RuntimeStreamPart
  yield { type: 'tool-input-delta', id: toolId, delta: '{"file_path"' } as RuntimeStreamPart
  yield { type: 'tool-input-delta', id: toolId, delta: ': "/tmp/example.txt"}' } as RuntimeStreamPart
  yield { type: 'tool-input-end', id: toolId } as RuntimeStreamPart

  yield {
    type: 'tool-call',
    toolCallId: toolId,
    toolName: 'Read',
    input: { file_path: '/tmp/example.txt' },
    providerExecuted: false,
    dynamic: false,
  } as RuntimeStreamPart

  yield {
    type: 'tool-result',
    toolCallId: toolId,
    toolName: 'Read',
    input: { file_path: '/tmp/example.txt' },
    output: 'file contents from fake runtime',
    dynamic: false,
  } as RuntimeStreamPart

  const closingId = `claude-text-${session.turnIndex}-end`
  yield { type: 'text-start', id: closingId } as RuntimeStreamPart
  yield { type: 'text-delta', id: closingId, text: 'Done reading.' } as RuntimeStreamPart
  yield { type: 'text-end', id: closingId } as RuntimeStreamPart

  yield {
    type: 'finish-step',
    finishReason: 'tool-calls',
    usage: USAGE,
    response: {},
  } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const claudePermission: FakeScript = async function* ({ session }) {
  const textId = `claude-text-${session.turnIndex}`
  const toolId = `toolu_${session.turnIndex}_perm`

  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'I need permission to run a command.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart

  yield {
    type: 'tool-input-start',
    id: toolId,
    toolName: 'Bash',
    providerExecuted: false,
    dynamic: false,
  } as RuntimeStreamPart
  yield { type: 'tool-input-delta', id: toolId, delta: '{"command":"echo hi"}' } as RuntimeStreamPart
  yield { type: 'tool-input-end', id: toolId } as RuntimeStreamPart

  yield {
    type: 'tool-approval-request',
    approvalId: toolId,
    toolCall: {
      type: 'tool-call',
      toolCallId: toolId,
      toolName: 'Bash',
      input: { command: 'echo hi' },
      providerExecuted: false,
      dynamic: false,
    },
  } as RuntimeStreamPart

  const decision = await session.waitForPermission(toolId)

  if (decision.type === 'deny') {
    yield {
      type: 'tool-error',
      toolCallId: toolId,
      toolName: 'Bash',
      input: { command: 'echo hi' },
      error: decision.reason ?? 'Permission denied',
      dynamic: false,
    } as RuntimeStreamPart
    yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
    return
  }

  yield {
    type: 'tool-call',
    toolCallId: toolId,
    toolName: 'Bash',
    input: decision.updatedInput ?? { command: 'echo hi' },
    providerExecuted: false,
    dynamic: false,
  } as RuntimeStreamPart
  yield {
    type: 'tool-result',
    toolCallId: toolId,
    toolName: 'Bash',
    input: { command: 'echo hi' },
    output: 'hi\n',
    dynamic: false,
  } as RuntimeStreamPart

  const closingId = `claude-text-${session.turnIndex}-end`
  yield { type: 'text-start', id: closingId } as RuntimeStreamPart
  yield { type: 'text-delta', id: closingId, text: 'Command finished.' } as RuntimeStreamPart
  yield { type: 'text-end', id: closingId } as RuntimeStreamPart

  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const claudeReasoning: FakeScript = async function* ({ session }) {
  const reasoningId = `claude-reasoning-${session.turnIndex}`
  const textId = `claude-text-${session.turnIndex}`

  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'reasoning-start', id: reasoningId } as RuntimeStreamPart
  yield { type: 'reasoning-delta', id: reasoningId, text: 'Let me think... ' } as RuntimeStreamPart
  yield { type: 'reasoning-delta', id: reasoningId, text: 'OK I have the answer.' } as RuntimeStreamPart
  yield { type: 'reasoning-end', id: reasoningId } as RuntimeStreamPart

  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'The answer is 42.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart

  yield {
    type: 'finish',
    finishReason: 'stop',
    totalUsage: { ...USAGE, outputTokenDetails: { textTokens: 6, reasoningTokens: 18 } },
  } as RuntimeStreamPart
}

export const claudeError: FakeScript = async function* ({ session }) {
  const textId = `claude-text-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'Trying to call an invalid tool.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart

  yield {
    type: 'error',
    error: 'rate_limit_error: rate limit exceeded',
  } as RuntimeStreamPart

  yield { type: 'finish', finishReason: 'error', totalUsage: USAGE } as RuntimeStreamPart
}

export const claudeEditDiff: FakeScript = async function* ({ session }) {
  const textId = `claude-text-${session.turnIndex}`
  const toolId = `toolu_${session.turnIndex}_edit`
  const editInput = {
    file_path: '/tmp/example.ts',
    old_string: 'const x = 1',
    new_string: 'const x = 42',
  }

  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'Updating the value.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart

  yield {
    type: 'tool-input-start',
    id: toolId,
    toolName: 'Edit',
    providerExecuted: false,
    dynamic: false,
  } as RuntimeStreamPart
  yield { type: 'tool-input-delta', id: toolId, delta: JSON.stringify(editInput) } as RuntimeStreamPart
  yield { type: 'tool-input-end', id: toolId } as RuntimeStreamPart

  yield {
    type: 'tool-call',
    toolCallId: toolId,
    toolName: 'Edit',
    input: editInput,
    providerExecuted: false,
    dynamic: false,
  } as RuntimeStreamPart
  yield {
    type: 'tool-result',
    toolCallId: toolId,
    toolName: 'Edit',
    input: editInput,
    output: 'Edited 1 occurrence',
    dynamic: false,
  } as RuntimeStreamPart

  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const claudeWriteDiff: FakeScript = async function* ({ session }) {
  const textId = `claude-text-${session.turnIndex}`
  const toolId = `toolu_${session.turnIndex}_write`
  const writeInput = {
    file_path: '/tmp/new-file.ts',
    content: 'export const greeting = "hello"\n',
  }

  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'Creating a new file.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart

  yield {
    type: 'tool-input-start',
    id: toolId,
    toolName: 'Write',
    providerExecuted: false,
    dynamic: false,
  } as RuntimeStreamPart
  yield { type: 'tool-input-delta', id: toolId, delta: JSON.stringify(writeInput) } as RuntimeStreamPart
  yield { type: 'tool-input-end', id: toolId } as RuntimeStreamPart

  yield {
    type: 'tool-call',
    toolCallId: toolId,
    toolName: 'Write',
    input: writeInput,
    providerExecuted: false,
    dynamic: false,
  } as RuntimeStreamPart
  yield {
    type: 'tool-result',
    toolCallId: toolId,
    toolName: 'Write',
    input: writeInput,
    output: 'File created',
    dynamic: false,
  } as RuntimeStreamPart

  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const claudePlan: FakeScript = async function* ({ session }) {
  const textId = `claude-text-${session.turnIndex}`
  const toolId = `toolu_${session.turnIndex}_plan`
  const planMarkdown = '# Refactor auth module\n- Step 1: extract token validator\n- Step 2: split session creation\n- Step 3: add tests'

  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'Here is the plan:' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart

  yield {
    type: 'tool-input-start',
    id: toolId,
    toolName: 'ExitPlanMode',
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
      toolName: 'ExitPlanMode',
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
      toolName: 'ExitPlanMode',
      input: { plan: planMarkdown },
      error: decision.reason ?? 'User wants to keep planning',
      dynamic: false,
    } as RuntimeStreamPart
    yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
    return
  }

  yield {
    type: 'tool-call',
    toolCallId: toolId,
    toolName: 'ExitPlanMode',
    input: { plan: planMarkdown },
    providerExecuted: false,
    dynamic: false,
  } as RuntimeStreamPart
  yield {
    type: 'tool-result',
    toolCallId: toolId,
    toolName: 'ExitPlanMode',
    input: { plan: planMarkdown },
    output: { approved: true },
    dynamic: false,
  } as RuntimeStreamPart

  const closingId = `claude-text-${session.turnIndex}-end`
  yield { type: 'text-start', id: closingId } as RuntimeStreamPart
  yield { type: 'text-delta', id: closingId, text: 'Starting implementation now.' } as RuntimeStreamPart
  yield { type: 'text-end', id: closingId } as RuntimeStreamPart

  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const claudeAskUserQuestion: FakeScript = async function* ({ session }) {
  const textId = `claude-text-${session.turnIndex}`
  const toolId = `toolu_${session.turnIndex}_ask`
  const askInput = {
    questions: [
      {
        id: 'q1',
        header: 'Color',
        question: 'Which theme color do you prefer?',
        type: 'choice',
        options: [
          { label: 'Blue', description: 'Calm and professional' },
          { label: 'Green', description: 'Fresh and natural' },
        ],
      },
    ],
  }

  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'I have a question.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart

  yield {
    type: 'tool-input-start',
    id: toolId,
    toolName: 'AskUserQuestion',
    providerExecuted: false,
    dynamic: false,
  } as RuntimeStreamPart
  yield { type: 'tool-input-delta', id: toolId, delta: JSON.stringify(askInput) } as RuntimeStreamPart
  yield { type: 'tool-input-end', id: toolId } as RuntimeStreamPart
  yield {
    type: 'tool-approval-request',
    approvalId: toolId,
    toolCall: {
      type: 'tool-call',
      toolCallId: toolId,
      toolName: 'AskUserQuestion',
      input: askInput,
      providerExecuted: false,
      dynamic: false,
    },
  } as RuntimeStreamPart

  const decision = await session.waitForPermission(toolId)

  if (decision.type === 'deny') {
    yield {
      type: 'tool-error',
      toolCallId: toolId,
      toolName: 'AskUserQuestion',
      input: askInput,
      error: 'User cancelled',
      dynamic: false,
    } as RuntimeStreamPart
    yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
    return
  }

  const answers = (decision.updatedInput as { answers?: Record<string, string> } | undefined)?.answers ?? {}
  yield {
    type: 'tool-call',
    toolCallId: toolId,
    toolName: 'AskUserQuestion',
    input: askInput,
    providerExecuted: false,
    dynamic: false,
  } as RuntimeStreamPart
  yield {
    type: 'tool-result',
    toolCallId: toolId,
    toolName: 'AskUserQuestion',
    input: askInput,
    output: { answers },
    dynamic: false,
  } as RuntimeStreamPart

  const closingId = `claude-text-${session.turnIndex}-end`
  yield { type: 'text-start', id: closingId } as RuntimeStreamPart
  yield { type: 'text-delta', id: closingId, text: `You picked ${Object.values(answers).join(', ') || 'nothing'}.` } as RuntimeStreamPart
  yield { type: 'text-end', id: closingId } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const claudeSubAgent: FakeScript = async function* ({ session }) {
  const textId = `claude-text-${session.turnIndex}`
  const agentId = `toolu_${session.turnIndex}_agent`
  const childRead = `toolu_${session.turnIndex}_child_read`
  const childBash = `toolu_${session.turnIndex}_child_bash`
  const agentInput = { description: 'Investigate the failing test', subagent_type: 'general-purpose' }
  const childMeta = { 'claude-code': { parentToolCallId: agentId } }

  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id: textId } as RuntimeStreamPart
  yield { type: 'text-delta', id: textId, text: 'Spawning a sub-agent.' } as RuntimeStreamPart
  yield { type: 'text-end', id: textId } as RuntimeStreamPart

  // Parent Agent tool: input-streaming → input-available
  yield {
    type: 'tool-input-start',
    id: agentId,
    toolName: 'Agent',
    providerExecuted: false,
    dynamic: false,
  } as RuntimeStreamPart
  yield { type: 'tool-input-delta', id: agentId, delta: JSON.stringify(agentInput) } as RuntimeStreamPart
  yield { type: 'tool-input-end', id: agentId } as RuntimeStreamPart
  yield {
    type: 'tool-call',
    toolCallId: agentId,
    toolName: 'Agent',
    input: agentInput,
    providerExecuted: false,
    dynamic: false,
  } as RuntimeStreamPart

  // Child tools, linked to parent via providerMetadata.parentToolCallId
  yield {
    type: 'tool-input-start',
    id: childRead,
    toolName: 'Read',
    providerExecuted: false,
    dynamic: false,
    providerMetadata: childMeta,
  } as RuntimeStreamPart
  yield {
    type: 'tool-call',
    toolCallId: childRead,
    toolName: 'Read',
    input: { file_path: '/tmp/failing.test.ts' },
    providerExecuted: false,
    dynamic: false,
    providerMetadata: childMeta,
  } as RuntimeStreamPart
  yield {
    type: 'tool-result',
    toolCallId: childRead,
    toolName: 'Read',
    input: { file_path: '/tmp/failing.test.ts' },
    output: 'expect(1).toBe(2)',
    dynamic: false,
  } as RuntimeStreamPart

  yield {
    type: 'tool-input-start',
    id: childBash,
    toolName: 'Bash',
    providerExecuted: false,
    dynamic: false,
    providerMetadata: childMeta,
  } as RuntimeStreamPart
  yield {
    type: 'tool-call',
    toolCallId: childBash,
    toolName: 'Bash',
    input: { command: 'npm test' },
    providerExecuted: false,
    dynamic: false,
    providerMetadata: childMeta,
  } as RuntimeStreamPart
  yield {
    type: 'tool-result',
    toolCallId: childBash,
    toolName: 'Bash',
    input: { command: 'npm test' },
    output: 'FAIL src/foo.test.ts',
    dynamic: false,
  } as RuntimeStreamPart

  // Parent Agent finishes
  yield {
    type: 'tool-result',
    toolCallId: agentId,
    toolName: 'Agent',
    input: agentInput,
    output: 'Investigation complete. Found 1 failing test.',
    dynamic: false,
  } as RuntimeStreamPart

  const closingId = `claude-text-${session.turnIndex}-end`
  yield { type: 'text-start', id: closingId } as RuntimeStreamPart
  yield { type: 'text-delta', id: closingId, text: 'Sub-agent finished.' } as RuntimeStreamPart
  yield { type: 'text-end', id: closingId } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}

export const claudeMultiTurn: FakeScript = async function* ({ session }) {
  const id = `claude-text-${session.turnIndex}`
  const reply =
    session.turnIndex === 0
      ? "Hi! What's your name?"
      : session.userMessage
        ? `Nice to meet you, ${session.userMessage}.`
        : "I didn't catch your name."

  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id } as RuntimeStreamPart
  yield { type: 'text-delta', id, text: reply } as RuntimeStreamPart
  yield { type: 'text-end', id } as RuntimeStreamPart
  yield {
    type: 'message-metadata',
    metadata: { providerMetadata: metadata({ turnIndex: session.turnIndex }) },
  } as RuntimeStreamPart
  yield { type: 'finish', finishReason: 'stop', totalUsage: USAGE } as RuntimeStreamPart
}
