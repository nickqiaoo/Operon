import { describe, it, expect } from 'vitest'
import type { AgentEvent } from 'operon-agents-core'
import { OperonStreamMapper, planReviewToolCallPart } from './message-mapper.js'

// --- minimal AgentEvent builders -------------------------------------------

function ev(address: string, body: Record<string, unknown>): AgentEvent {
  return { address, sessionId: 's1', ...body } as unknown as AgentEvent
}

// A tool call surfaces via the `tool.call.started` AgentEvent — the framework's authoritative
// per-call signal (carries name + full args). The mapper emits the tool-call part from it.
function toolCall(address: string, id: string, name: string, args: unknown = {}): AgentEvent {
  return ev(address, { type: 'tool.call.started', toolCallId: id, toolName: name, args })
}

function toolResult(address: string, r: { toolCallId: string; toolName: string; text: string; isError?: boolean }): AgentEvent {
  return ev(address, {
    type: 'tool.result',
    toolCallId: r.toolCallId,
    toolName: r.toolName,
    result: { content: [{ type: 'text', text: r.text }] },
    isError: r.isError ?? false,
  })
}

function toolProgress(address: string, r: { toolCallId: string; toolName: string; text: string }): AgentEvent {
  return ev(address, {
    type: 'tool.progress',
    toolCallId: r.toolCallId,
    toolName: r.toolName,
    args: {},
    update: { kind: 'custom', text: r.text },
  })
}

// The real framework's `agent.started` carries the id of the tool call that spawned the
// sub-agent; omit it to model an unbound spawn (workflow fan-out / background agent).
function agentStart(address: string, agent: string, parentToolCallId?: string): AgentEvent {
  return ev(address, { type: 'agent.started', agent, ...(parentToolCallId ? { parentToolCallId } : {}) })
}

function parentTag(part: unknown): string | undefined {
  const meta = (part as { providerMetadata?: { operon?: { parentToolCallId?: string } } }).providerMetadata
  return meta?.operon?.parentToolCallId
}

// ---------------------------------------------------------------------------

describe('OperonStreamMapper sub-agent correlation', () => {
  it('tags a sub-agent tool step with the spawning Agent tool call id', () => {
    const m = new OperonStreamMapper()
    // Top-level Agent spawn.
    m.map(toolCall('main', 'agent-call-1', 'Agent', { subagent_type: 'coder', description: 'investigate' }))
    // Sub-agent begins; its `agent.started` names the spawning Agent tool call.
    m.map(agentStart('main/coder-abc', 'coder', 'agent-call-1'))
    // Sub-agent runs a tool.
    const childCallParts = m.map(toolCall('main/coder-abc', 'child-read-1', 'Read', { file_path: '/x' }))
    const childResultParts = m.map(toolResult('main/coder-abc', { toolCallId: 'child-read-1', toolName: 'Read', text: 'file body' }))

    const childCall = childCallParts.find((p) => (p as { type?: string }).type === 'tool-call')
    expect(childCall).toBeDefined()
    expect(parentTag(childCall)).toBe('agent-call-1')
    // The result is tagged with the same parent so it nests under the Agent task.
    const childResult = childResultParts.find((p) => (p as { type?: string }).type === 'tool-result')
    expect(childResult).toBeDefined()
    expect(parentTag(childResult)).toBe('agent-call-1')
  })

  it('emits a top-level tool-result from tool.result (the spinner fix)', () => {
    // Regression: results used to ride turn.ended.toolResults (trailing-only), so a turn
    // ending on assistant text reported none → every tool spun forever. tool.result
    // fires per result, keyed by toolCallId.
    const m = new OperonStreamMapper()
    m.map(toolCall('main', 'bash-1', 'Bash', { command: 'ls' }))
    const parts = m.map(toolResult('main', { toolCallId: 'bash-1', toolName: 'Bash', text: 'a.txt\nb.txt' }))
    const result = parts.find((p) => (p as { type?: string }).type === 'tool-result') as
      | { toolCallId?: string; toolName?: string; output?: string }
      | undefined
    expect(result).toBeDefined()
    expect(result!.toolCallId).toBe('bash-1')
    expect(result!.toolName).toBe('Bash')
    expect(result!.output).toBe('a.txt\nb.txt')
    // Top-level results carry no parent tag (they are not nested under an Agent task).
    expect(parentTag(result)).toBeUndefined()
  })

  it('accumulates tool.progress into live progress output (workflow card not empty)', () => {
    const m = new OperonStreamMapper()
    m.map(toolCall('main', 'wf-1', 'Workflow', {}))
    const p1 = m.map(toolProgress('main', { toolCallId: 'wf-1', toolName: 'Workflow', text: 'Phase: Greet' }))
    const p2 = m.map(toolProgress('main', { toolCallId: 'wf-1', toolName: 'Workflow', text: 'agent sum done' }))
    const out = (parts: unknown[]) => (parts.find((p) => (p as { type?: string }).type === 'tool-result') as { output?: string } | undefined)?.output
    expect(out(p1)).toBe('Phase: Greet')
    expect(out(p2)).toBe('Phase: Greet\nagent sum done') // accumulates across updates
    // The real result replaces the accumulated progress.
    const fin = m.map(toolResult('main', { toolCallId: 'wf-1', toolName: 'Workflow', text: 'workflow done' }))
    expect(out(fin)).toBe('workflow done')
  })

  it('maps workflow progress to an isSubagentProgress activity list (rich card)', () => {
    const m = new OperonStreamMapper()
    m.map(toolCall('main', 'wf-1', 'Workflow', {}))
    const wf = (data: unknown): AgentEvent =>
      ev('main', { type: 'tool.progress', toolCallId: 'wf-1', toolName: 'Workflow', args: {}, update: { kind: 'custom', customKind: 'workflow', customData: data, text: 'x' } })
    type Prog = { isSubagentProgress?: boolean; state?: string; recentActivity?: Array<{ type: string; content: string; status: string }> }
    const prog = (parts: unknown[]): Prog | undefined =>
      (parts.find((p) => (p as { type?: string }).type === 'tool-result') as { output?: Prog } | undefined)?.output

    m.map(wf({ type: 'phase', index: 0, title: 'Greet' }))
    const p1 = prog(m.map(wf({ type: 'agent', record: { index: 0, label: 'sum', state: 'running' } })))
    expect(p1?.isSubagentProgress).toBe(true)
    expect(p1?.state).toBe('running')
    expect(p1?.recentActivity?.some((a) => a.content.includes('Greet'))).toBe(true)
    expect(p1?.recentActivity?.some((a) => a.type === 'tool_call' && a.status === 'running')).toBe(true)

    // Same agent index updates in place (no duplicate), running → completed.
    const p2 = prog(m.map(wf({ type: 'agent', record: { index: 0, label: 'sum', state: 'done', resultPreview: 'OK' } })))
    const agents = p2?.recentActivity?.filter((a) => a.type === 'tool_call') ?? []
    expect(agents.length).toBe(1)
    expect(agents[0]?.status).toBe('completed')

    // End keeps the activity list, marks completed, appends the final result.
    const fin = prog(m.map(toolResult('main', { toolCallId: 'wf-1', toolName: 'Workflow', text: 'workflow done' })))
    expect(fin?.isSubagentProgress).toBe(true)
    expect(fin?.state).toBe('completed')
    expect(fin?.recentActivity?.some((a) => a.content.includes('workflow done'))).toBe(true)
  })

  it('maps a failed tool to tool-error', () => {
    const m = new OperonStreamMapper()
    m.map(toolCall('main', 'w-1', 'Write', {}))
    const parts = m.map(toolResult('main', { toolCallId: 'w-1', toolName: 'Write', text: 'ENOENT', isError: true }))
    const err = parts.find((p) => (p as { type?: string }).type === 'tool-error') as { toolCallId?: string } | undefined
    expect(err).toBeDefined()
    expect(err!.toolCallId).toBe('w-1')
  })

  it('binds each sub-agent to the Agent call named on its agent.started (parallel-safe)', () => {
    const m = new OperonStreamMapper()
    m.map(toolCall('main', 'agent-call-1', 'Agent'))
    m.map(toolCall('main', 'agent-call-2', 'Agent'))

    // Each sub-agent's agent.started names its own spawning call — no ordering guess.
    m.map(agentStart('main/sub-1', 'coder', 'agent-call-1'))
    const a = m.map(toolCall('main/sub-1', 'c1', 'Bash')).find((p) => (p as { type?: string }).type === 'tool-call')
    expect(parentTag(a)).toBe('agent-call-1')

    m.map(agentStart('main/sub-2', 'coder', 'agent-call-2'))
    const b = m.map(toolCall('main/sub-2', 'c2', 'Bash')).find((p) => (p as { type?: string }).type === 'tool-call')
    expect(parentTag(b)).toBe('agent-call-2')
  })

  it('keeps all events of one sub-agent (incl. deeper descendants) under the same parent', () => {
    const m = new OperonStreamMapper()
    m.map(toolCall('main', 'agent-call-1', 'Agent'))
    m.map(agentStart('main/sub-1', 'coder', 'agent-call-1'))

    const direct = m.map(toolCall('main/sub-1', 'c1', 'Read')).find((p) => (p as { type?: string }).type === 'tool-call')
    // A grandchild (sub-agent spawned by the sub-agent) shares the root segment.
    const deep = m.map(toolCall('main/sub-1/grandchild', 'c2', 'Bash')).find((p) => (p as { type?: string }).type === 'tool-call')

    expect(parentTag(direct)).toBe('agent-call-1')
    expect(parentTag(deep)).toBe('agent-call-1')
  })

  it('drops unbound sub-agent events (no pending Agent spawn) instead of mis-attributing', () => {
    const m = new OperonStreamMapper()
    // No Agent toolcall queued (e.g. Workflow fan-out or background agent).
    m.map(agentStart('main/worker-1', 'coder'))
    const parts = m.map(toolCall('main/worker-1', 'c1', 'Bash'))
    expect(parts).toEqual([])
  })

  it('does not treat top-level Agent tool calls as their own children', () => {
    const m = new OperonStreamMapper()
    const parts = m.map(toolCall('main', 'agent-call-1', 'Agent'))
    const call = parts.find((p) => (p as { type?: string }).type === 'tool-call')
    expect(call).toBeDefined()
    // The parent Agent task carries no parentToolCallId of its own.
    expect(parentTag(call)).toBeUndefined()
  })
})

describe('OperonStreamMapper goal mapping', () => {
  it('maps goal_updated to codexGoal message-metadata the banner consumes', () => {
    const m = new OperonStreamMapper()
    const parts = m.map(ev('main', {
      type: 'goal.updated',
      snapshot: {
        objective: 'ship the feature',
        status: 'active',
        tokensUsed: 1200,
        wallClockMs: 90_000,
        budget: { tokenBudget: 50_000 },
      },
    }))
    const meta = parts.find((p) => (p as { type?: string }).type === 'message-metadata') as
      | { metadata?: { codexGoal?: Record<string, unknown> } }
      | undefined
    expect(meta?.metadata?.codexGoal).toEqual({
      objective: 'ship the feature',
      status: 'active',
      tokenBudget: 50_000,
      tokensUsed: 1200,
      timeUsedSeconds: 90,
    })
  })
})

describe('OperonStreamMapper todo bridging', () => {
  const findCall = (parts: unknown[]) => parts.find((p) => (p as { type?: string }).type === 'tool-call') as
    | { toolName?: string; input?: { todos?: Array<{ content: string; status: string }> } }
    | undefined

  it('remaps TodoList → TodoWrite with content/completed item shape the UI renderer reads', () => {
    const m = new OperonStreamMapper()
    const parts = m.map(toolCall('main', 'todo-1', 'TodoList', {
      todos: [
        { title: 'wire mapper', status: 'done' },
        { title: 'add tests', status: 'in_progress' },
        { title: 'ship it', status: 'pending' },
      ],
    }))
    const call = findCall(parts)
    expect(call?.toolName).toBe('TodoWrite')
    expect(call?.input?.todos).toEqual([
      { content: 'wire mapper', status: 'completed' },
      { content: 'add tests', status: 'in_progress' },
      { content: 'ship it', status: 'pending' },
    ])
  })

  it('remaps the tool name even on a no-arg read (todos absent)', () => {
    const m = new OperonStreamMapper()
    const call = findCall(m.map(toolCall('main', 'todo-2', 'TodoList', {})))
    expect(call?.toolName).toBe('TodoWrite')
  })

  it('leaves non-todo tools untouched', () => {
    const m = new OperonStreamMapper()
    const call = findCall(m.map(toolCall('main', 'b-1', 'Bash', { command: 'ls' })))
    expect(call?.toolName).toBe('Bash')
  })
})

describe('planReviewToolCallPart', () => {
  it('re-emits the ExitPlanMode tool-call with plan markdown from the approval display', () => {
    const part = planReviewToolCallPart({
      toolName: 'ExitPlanMode',
      toolCallId: 'plan-1',
      display: { kind: 'plan_review', plan: '# Plan\n- step', path: '/p/plan.md' },
    }) as { type: string; toolCallId: string; toolName: string; input: Record<string, unknown> } | null
    expect(part).not.toBeNull()
    expect(part!.type).toBe('tool-call')
    expect(part!.toolCallId).toBe('plan-1')
    expect(part!.toolName).toBe('ExitPlanMode')
    expect(part!.input.plan).toBe('# Plan\n- step')
    expect(part!.input.path).toBe('/p/plan.md')
  })

  it('carries options through only when there are at least two', () => {
    const opts = [
      { label: 'A', description: 'first' },
      { label: 'B', description: 'second' },
    ]
    const withOpts = planReviewToolCallPart({
      toolName: 'ExitPlanMode',
      toolCallId: 'p',
      display: { kind: 'plan_review', plan: 'x', options: opts },
    }) as { input: Record<string, unknown> }
    expect(withOpts.input.options).toEqual(opts)

    const oneOpt = planReviewToolCallPart({
      toolName: 'ExitPlanMode',
      toolCallId: 'p',
      display: { kind: 'plan_review', plan: 'x', options: [opts[0]] },
    }) as { input: Record<string, unknown> }
    expect(oneOpt.input.options).toBeUndefined()
  })

  it('returns null for non-plan approvals', () => {
    expect(planReviewToolCallPart({ toolName: 'Bash', toolCallId: 'b', display: {} })).toBeNull()
    expect(planReviewToolCallPart({ toolName: 'ExitPlanMode', toolCallId: 'e', display: { title: 'Exit plan mode' } })).toBeNull()
  })
})
