import { describe, expect, it } from 'vitest'
import type * as acp from '@zed-industries/agent-client-protocol'
import { AcpEventMapper } from './event-mapper.js'

function types(parts: { type: string }[]): string[] {
  return parts.map((p) => p.type)
}

interface AcpContextUsage {
  promptTokens: number
  contextWindow?: number
  percentUsed?: number
}

/** Pull the acp providerMetadata's contextUsage off a finish-step part. */
function contextUsageOf(parts: { type: string }[]): AcpContextUsage | undefined {
  const finishStep = parts.find((p) => p.type === 'finish-step') as
    | { providerMetadata?: unknown }
    | undefined
  const metadata = finishStep?.providerMetadata as
    | { acp?: { contextUsage?: AcpContextUsage } }
    | undefined
  return metadata?.acp?.contextUsage
}

describe('AcpEventMapper', () => {
  it('maps thought and message chunks to reasoning/text deltas', () => {
    const mapper = new AcpEventMapper('sess-1', 'grok-4.5', [])
    expect(types(mapper.startStep())).toEqual(['start-step'])

    const thought = mapper.handleUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'thinking' },
    } as acp.SessionNotification['update'])
    expect(types(thought)).toEqual(['reasoning-start', 'reasoning-delta'])

    const text = mapper.handleUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    } as acp.SessionNotification['update'])
    expect(types(text)).toEqual(['text-start', 'text-delta'])
  })

  it('emits input + call + result for a completed tool call', () => {
    const mapper = new AcpEventMapper('sess-2', 'grok-4.5', [])
    mapper.startStep()

    const call = mapper.handleUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Bash',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'echo hi' },
    } as acp.SessionNotification['update'])
    expect(types(call)).toEqual(['tool-input-start', 'tool-input-delta', 'tool-input-end', 'tool-call'])

    const update = mapper.handleUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'hi' } }],
    } as acp.SessionNotification['update'])
    expect(types(update)).toEqual(['tool-result'])
    const result = update.find((p) => p.type === 'tool-result') as { output: { output: string } }
    expect(result.output.output).toBe('hi')
  })

  it('keeps arguments that arrive after the initial tool_call carried none', () => {
    // grok announces the call first and sends rawInput in a later update. The
    // mapper used to finalize on that first notification, shipping tool-call
    // with `{}` and dropping the real arguments — the UI showed "No parameters."
    const mapper = new AcpEventMapper('sess-late-args', 'grok-4.5', [])
    mapper.startStep()

    const announced = mapper.handleUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't-late',
      title: 'grep',
      kind: 'search',
      status: 'pending',
    } as acp.SessionNotification['update'])
    // Started, but not closed: the arguments are still unknown.
    expect(types(announced)).toEqual(['tool-input-start'])

    const withArgs = mapper.handleUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't-late',
      status: 'in_progress',
      rawInput: { pattern: 'agent\\(', path: 'src' },
    } as acp.SessionNotification['update'])
    expect(types(withArgs)).toEqual(['tool-input-delta', 'tool-input-end', 'tool-call'])

    const call = withArgs.find((p) => p.type === 'tool-call') as { input: string }
    expect(JSON.parse(call.input)).toEqual({ pattern: 'agent\\(', path: 'src' })

    const done = mapper.handleUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't-late',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '26 matches' } }],
    } as acp.SessionNotification['update'])
    const result = done.find((p) => p.type === 'tool-result') as { input: string; output: { output: string } }
    // The result must carry the real arguments too, not the placeholder.
    expect(JSON.parse(result.input)).toEqual({ pattern: 'agent\\(', path: 'src' })
    expect(result.output.output).toBe('26 matches')
  })

  it('still finalizes a tool that genuinely has no arguments', () => {
    const mapper = new AcpEventMapper('sess-no-args', 'grok-4.5', [])
    mapper.startStep()
    mapper.handleUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't-none',
      title: 'ListTools',
      status: 'pending',
    } as acp.SessionNotification['update'])
    // No rawInput ever arrives — the result has to close it out anyway.
    const done = mapper.handleUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't-none',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
    } as acp.SessionNotification['update'])
    expect(types(done)).toEqual(['tool-input-delta', 'tool-input-end', 'tool-call', 'tool-result'])
    const call = done.find((p) => p.type === 'tool-call') as { input: string }
    expect(call.input).toBe('{}')
  })

  it('splits text across a tool boundary so the tool stays in order', () => {
    const mapper = new AcpEventMapper('sess-order', 'grok-4.5', [])
    mapper.startStep()

    const before = mapper.handleUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hi — checking saved context.' },
    } as acp.SessionNotification['update'])
    expect(types(before)).toEqual(['text-start', 'text-delta'])
    const beforeTextId = (before.find((p) => p.type === 'text-start') as { id: string }).id

    // The tool call must close the open text first so it is ordered AFTER it.
    const call = mapper.handleUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'search_tool',
      status: 'pending',
      rawInput: { query: 'greeting' },
    } as acp.SessionNotification['update'])
    expect(types(call)).toEqual(['text-end', 'tool-input-start', 'tool-input-delta', 'tool-input-end', 'tool-call'])

    // Text after the tool must open a NEW part so it renders below the tool.
    const after = mapper.handleUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hi — what can I help you with?' },
    } as acp.SessionNotification['update'])
    expect(types(after)).toEqual(['text-start', 'text-delta'])
    const afterTextId = (after.find((p) => p.type === 'text-start') as { id: string }).id
    expect(afterTextId).not.toBe(beforeTextId)
  })

  it('marks a failed tool call as tool-error', () => {
    const mapper = new AcpEventMapper('sess-3', 'grok-4.5', [])
    mapper.startStep()
    const parts = mapper.handleUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't2',
      title: 'Read',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'boom' } }],
    } as acp.SessionNotification['update'])
    expect(types(parts)).toContain('tool-error')
  })

  // Verbatim shape of a real grok node_repl failure: no content at all, the whole error under
  // rawOutput.output.Error. Reading only `content` here reported "Tool execution failed" and
  // dropped the message, which is the only thing that says what went wrong.
  it('recovers a failed tool call message from rawOutput when content is empty', () => {
    const mapper = new AcpEventMapper('sess-3b', 'grok-4.5', [])
    mapper.startStep()
    const parts = mapper.handleUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't3',
      status: 'failed',
      rawOutput: {
        type: 'MCP',
        tool_name: 'js',
        server_name: 'node_repl',
        output: { Error: 'Error: Browser is not available: chrome' },
        is_error: true,
      },
    } as acp.SessionNotification['update'])
    const toolError = parts.find((p) => p.type === 'tool-error') as { error?: Error } | undefined
    expect(toolError?.error?.message).toBe('Error: Browser is not available: chrome')
  })

  it('synthesizes a tool-approval-request from a permission request', () => {
    const mapper = new AcpEventMapper('sess-4', 'grok-4.5', [])
    mapper.startStep()
    const parts = mapper.handlePermissionRequest('appr-1', {
      toolCallId: 't3',
      title: 'Write file',
      kind: 'edit',
      rawInput: { path: 'a.txt' },
    } as acp.ToolCallUpdate)
    expect(types(parts)).toContain('tool-approval-request')
    const approval = parts.find((p) => p.type === 'tool-approval-request') as { approvalId: string }
    expect(approval.approvalId).toBe('appr-1')
  })

  it('tracks current mode from current_mode_update', () => {
    const mapper = new AcpEventMapper('sess-5', 'grok-4.5', [])
    mapper.handleUpdate({
      sessionUpdate: 'current_mode_update',
      currentModeId: 'plan',
    } as acp.SessionNotification['update'])
    expect(mapper.getCurrentModeId()).toBe('plan')
  })

  it('closes open content and finishes on finalize', () => {
    const mapper = new AcpEventMapper('sess-6', 'grok-4.5', [])
    mapper.startStep()
    mapper.handleUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'done' },
    } as acp.SessionNotification['update'])
    const parts = mapper.finalize('end_turn')
    expect(types(parts)).toContain('text-end')
    expect(types(parts)).toContain('finish-step')
    expect(types(parts)).toContain('finish')
  })

  it('reports zero usage when no parseUsage hook is supplied', () => {
    const mapper = new AcpEventMapper('sess-usage-0', 'grok-4.5', [])
    mapper.startStep()
    const parts = mapper.finalize('end_turn', { usage: { inputTokens: 5 } })
    const finishStep = parts.find((p) => p.type === 'finish-step') as { usage: { totalTokens: number } }
    expect(finishStep.usage.totalTokens).toBe(0)
  })

  it('populates finish usage from the parseUsage hook on the prompt _meta', () => {
    const parseUsage = (meta: Record<string, unknown> | undefined) =>
      meta
        ? {
            inputTokens: 100,
            inputTokenDetails: { noCacheTokens: 60, cacheReadTokens: 40, cacheWriteTokens: 0 },
            outputTokens: 10,
            outputTokenDetails: { textTokens: undefined, reasoningTokens: 3 },
            totalTokens: 110,
            raw: undefined,
            reasoningTokens: 3,
            cachedInputTokens: 40,
          }
        : undefined
    const mapper = new AcpEventMapper('sess-usage-1', 'grok-4.5', [], parseUsage)
    mapper.startStep()
    const parts = mapper.finalize('end_turn', { usage: { totalTokens: 110 } })
    const finishStep = parts.find((p) => p.type === 'finish-step') as { usage: { totalTokens: number; inputTokens: number } }
    const finish = parts.find((p) => p.type === 'finish') as { totalUsage: { totalTokens: number } }
    expect(finishStep.usage.inputTokens).toBe(100)
    expect(finishStep.usage.totalTokens).toBe(110)
    expect(finish.totalUsage.totalTokens).toBe(110)
  })

  it('reports context usage from the live gauge, not the turn usage', () => {
    // The trap this guards: a turn's `inputTokens` is summed over its model
    // calls, each re-sending the whole context as cache reads. Here 5 calls over
    // a 15K context report 75K input — using that as occupancy over-reports ~5x
    // (and exceeds the window on long turns). Only the gauge is context.
    const parseUsage = () => ({
      inputTokens: 75_000,
      inputTokenDetails: { noCacheTokens: 15_000, cacheReadTokens: 60_000, cacheWriteTokens: 0 },
      outputTokens: 200,
      outputTokenDetails: { textTokens: undefined, reasoningTokens: 0 },
      totalTokens: 75_200,
      raw: undefined,
      reasoningTokens: 0,
      cachedInputTokens: 60_000,
    })
    const parseContextTokens = (meta: Record<string, unknown> | undefined) =>
      typeof meta?.totalTokens === 'number' ? meta.totalTokens : undefined

    const mapper = new AcpEventMapper(
      'sess-ctx-1',
      'grok-4.5',
      [],
      parseUsage,
      parseContextTokens,
      500_000,
    )
    mapper.startStep()
    mapper.handleUpdate(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } as acp.SessionNotification['update'],
      { totalTokens: 15_000 },
    )
    expect(contextUsageOf(mapper.finalize('end_turn', {}))).toEqual({
      promptTokens: 15_000,
      contextWindow: 500_000,
      percentUsed: 0.03,
    })
  })

  it('tracks the newest gauge reading and omits context usage without one', () => {
    const parseContextTokens = (meta: Record<string, unknown> | undefined) =>
      typeof meta?.totalTokens === 'number' ? meta.totalTokens : undefined
    const chunk = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'x' },
    } as acp.SessionNotification['update']

    // A gauge can dip as the prompt is re-assembled; last reading wins.
    const tracked = new AcpEventMapper('sess-ctx-2', 'grok-4.5', [], undefined, parseContextTokens, 500_000)
    tracked.startStep()
    tracked.handleUpdate(chunk, { totalTokens: 15_002 })
    tracked.handleUpdate(chunk, { totalTokens: 14_986 })
    tracked.handleUpdate(chunk, {}) // no reading — must not clear the last one
    expect(contextUsageOf(tracked.finalize('end_turn', {}))?.promptTokens).toBe(14_986)

    // Providers with no gauge (no hook) surface no context usage at all, rather
    // than a percentage derived from the wrong number.
    const bare = new AcpEventMapper('sess-ctx-3', 'grok-4.5', [])
    bare.startStep()
    bare.handleUpdate(chunk, { totalTokens: 15_000 })
    expect(contextUsageOf(bare.finalize('end_turn', {}))).toBeUndefined()
  })
})

  // Mirror of the failure case above, on the success path: grok reports a completed
  // node_repl call with empty `content` and the payload under output.OkayOutput.
  // Reading only `content` shipped `{output: ""}` and buried the result in `raw`.
  it('recovers a completed tool call payload from rawOutput when content is empty', () => {
    const mapper = new AcpEventMapper('sess-3c', 'grok-4.5', [])
    mapper.startStep()
    const parts = mapper.handleUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't4',
      status: 'completed',
      rawOutput: {
        type: 'MCP',
        tool_name: 'js',
        server_name: 'node_repl',
        output: { OkayOutput: 'App=com.tencent.qq (pid 9797)\n0 标准窗口 QQ' },
      },
    } as acp.SessionNotification['update'])
    const result = parts.find((p) => p.type === 'tool-result') as { output?: { output?: string } }
    expect(result?.output?.output).toBe('App=com.tencent.qq (pid 9797)\n0 标准窗口 QQ')
  })

  it('keeps content as the primary source when it is present', () => {
    const mapper = new AcpEventMapper('sess-3d', 'grok-4.5', [])
    mapper.startStep()
    const parts = mapper.handleUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't5',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'from content' } }],
      rawOutput: { output: { OkayOutput: 'from raw' } },
    } as acp.SessionNotification['update'])
    const result = parts.find((p) => p.type === 'tool-result') as { output?: { output?: string } }
    expect(result?.output?.output).toBe('from content')
  })
