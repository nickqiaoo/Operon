import type { RuntimeStreamPart } from '@operon/agent-runtime'
import { describe, expect, it } from 'vitest'
import type { Activity, AssistantMessage } from '../../../../shared/assistant.js'
import { ActivityProjector, AssistantProjector, briefError } from './projector.js'

const p = (part: Record<string, unknown>) => part as unknown as RuntimeStreamPart

/** A reply as an agent streams it: one text block. */
function said(projector: { part(part: RuntimeStreamPart): void }, text: string, id = 't1'): void {
  projector.part(p({ type: 'text-start', id }))
  projector.part(p({ type: 'text-delta', id, text }))
  projector.part(p({ type: 'text-end', id }))
}

function thread() {
  const messages = new Map<string, AssistantMessage>()
  const typing: boolean[] = []
  const activities = new Map<string, Activity>()
  let n = 0
  const projector = new AssistantProjector(
    { message: (m) => messages.set(m.id, { ...m }), typing: (t) => typing.push(t), activity: (a) => activities.set(a.id, a) },
    () => `m${++n}`,
    () => 1000,
  )
  return { projector, messages: () => [...messages.values()], typing, activities: () => [...activities.values()] }
}

describe('AssistantProjector (the thread)', () => {
  it('shows each piece of text the agent says between tool calls as its own reply', () => {
    const t = thread()
    t.projector.begin({ kind: 'user' })
    t.projector.part(p({ type: 'text-delta', id: 'a', text: 'On it.' }))
    t.projector.part(p({ type: 'tool-call', toolCallId: 'c1', toolName: 'mcp__assistant__start_task', input: {} }))
    said(t.projector, 'Back soon.', 'b')
    t.projector.end()
    expect(t.messages().map((m) => m.text)).toEqual(['On it.', 'Back soon.'])
    expect(t.typing).toEqual([true, false])
  })

  // Which task a reply is about could only be guessed from timing, and the guess was wrong when
  // two things were in flight — so replies carry no activity at all.
  it('does not link replies to a task, even around a dispatch or a finished-task notice', () => {
    const t = thread()
    t.projector.begin({ kind: 'user' })
    said(t.projector, 'Looking into it.')
    t.projector.part(p({ type: 'tool-call', toolCallId: 'c1', toolName: 'mcp__assistant__start_task', input: {} }))
    t.projector.setCause({ kind: 'worker', activityId: 'w1' })
    said(t.projector, 'Done — 3 files.')
    t.projector.end()
    for (const message of t.messages()) expect(message.activityId).toBeUndefined()
  })

  it('marks the reply to a finished-task notice as triggered by that worker', () => {
    const t = thread()
    t.projector.begin({ kind: 'worker', activityId: 'w3' })
    said(t.projector, 'Done — 3 files.')
    t.projector.end()
    expect(t.messages()[0]).toMatchObject({ trigger: { kind: 'worker', activityId: 'w3' } })
  })

  it('tags replies to the heartbeat and to a scheduled task', () => {
    const t = thread()
    t.projector.begin({ kind: 'heartbeat', activityId: 'h1' })
    said(t.projector, 'Your bank wrote.')
    t.projector.end()
    t.projector.begin({ kind: 'schedule', name: 'Morning brief' })
    said(t.projector, 'Here is today.')
    t.projector.end()
    expect(t.messages().map((m) => m.trigger)).toEqual([{ kind: 'heartbeat' }, { kind: 'schedule', name: 'Morning brief' }])
  })

  it('follows a cause injected into a running turn', () => {
    const t = thread()
    t.projector.begin({ kind: 'user' })
    said(t.projector, 'Sure.')
    t.projector.setCause({ kind: 'worker', activityId: 'w4' })
    said(t.projector, 'And the report is ready.', 't2')
    t.projector.end()
    expect(t.messages().map((m) => m.trigger?.kind ?? 'user')).toEqual(['user', 'worker'])
  })

  it('carries over the cause of a turn the agent started on its own', () => {
    const t = thread()
    t.projector.begin({ kind: 'worker', activityId: 'w5' })
    t.projector.end()
    t.projector.begin()
    said(t.projector, 'One more thing about it.')
    t.projector.end()
    expect(t.messages()[0]).toMatchObject({ trigger: { kind: 'worker', activityId: 'w5' } })
  })

  it('attaches a line saved before any reply to the next reply only', () => {
    const t = thread()
    t.projector.begin({ kind: 'user' })
    t.projector.remember('Prefers driving')
    said(t.projector, 'Noted.')
    said(t.projector, 'Anything else?', 't2')
    t.projector.end()
    expect(t.messages().map((m) => m.remembered)).toEqual([['Prefers driving'], undefined])
  })

  it('puts a line saved after the reply onto that same reply', () => {
    const t = thread()
    t.projector.begin({ kind: 'user' })
    said(t.projector, 'Got it.')
    t.projector.remember('Daughter: Duoduo')
    t.projector.end()
    expect(t.messages()).toEqual([expect.objectContaining({ text: 'Got it.', remembered: ['Daughter: Duoduo'] })])
  })

  it('says something when a turn fails, and nothing when it was stopped', () => {
    const t = thread()
    t.projector.begin({ kind: 'user' })
    t.projector.end({ error: '402 {"error":{"message":"needs more credits"}}' })
    t.projector.begin({ kind: 'user' })
    t.projector.end({ error: 'aborted', aborted: true })
    expect(t.messages().map((m) => m.text)).toEqual(['Something went wrong on my side: 402 · needs more credits'])
  })

  it('keeps a turn that only looked at the coding work out of Activity', () => {
    const t = thread()
    t.projector.begin({ kind: 'user' })
    for (const [id, tool] of [['l1', 'workspace_list'], ['l2', 'waiting_list'], ['l3', 'workspace_overview']]) {
      t.projector.part(p({ type: 'tool-call', toolCallId: id, toolName: `mcp__assistant__${tool}`, input: {} }))
      t.projector.part(p({ type: 'tool-result', toolCallId: id, output: '…' }))
    }
    said(t.projector, 'Nothing is waiting for you.')
    t.projector.end()
    expect(t.activities()).toEqual([])
  })

  it('records a turn that changed something as a main-agent activity, its calls the steps', () => {
    const t = thread()
    t.projector.begin({ kind: 'user' })
    t.projector.part(p({ type: 'tool-call', toolCallId: 'q1', toolName: 'mcp__assistant__memory_search', input: { query: 'calendar' } }))
    t.projector.part(p({ type: 'tool-call', toolCallId: 'c1', toolName: 'Edit', input: { file_path: '/home/a/.operon/assistant/memory.md', old_string: '# People', new_string: '- No Google Calendar\n\n# People', description: 'Note: no Google Calendar' } }))
    t.projector.part(p({ type: 'tool-result', toolCallId: 'c1', output: 'The file has been updated.' }))
    t.projector.part(p({ type: 'tool-call', toolCallId: 'c2', toolName: 'mcp__assistant__set_identity', input: { user_name: 'Nick' } }))
    t.projector.part(p({ type: 'tool-result', toolCallId: 'c2', output: 'Saved identity.md.' }))
    said(t.projector, 'Noted: no Google Calendar.')
    t.projector.end()
    const [activity] = t.activities()
    expect(t.activities()).toHaveLength(1)
    expect(activity).toMatchObject({ agent: 'main', taskId: `am-${activity!.id}`, title: 'Note: no Google Calendar', status: 'done', summary: 'Noted: no Google Calendar.' })
    expect(activity!.steps.map((s) => [s.label, s.status])).toEqual([
      ['Note: no Google Calendar', 'done'],
      ['Update identity.md', 'done'],
    ])
  })

  it("reads the description out of Codex's MCP call envelope", () => {
    const t = thread()
    t.projector.begin({ kind: 'user' })
    t.projector.part(p({ type: 'tool-call', toolCallId: 'c1', toolName: 'mcp__assistant__schedule_delete', input: { server: 'assistant', tool: 'schedule_delete', arguments: { id: 10, description: 'Delete the test schedule' } } }))
    t.projector.end()
    expect(t.activities()[0]).toMatchObject({ title: 'Delete the test schedule', steps: [{ label: 'Delete the test schedule' }] })
  })

  it('records nothing for a turn that only talked, looked things up or handed out work', () => {
    const t = thread()
    t.projector.begin({ kind: 'user' })
    t.projector.part(p({ type: 'tool-call', toolCallId: 'q1', toolName: 'mcp__assistant__memory_search', input: { query: 'x' } }))
    t.projector.part(p({ type: 'tool-call', toolCallId: 'c1', toolName: 'mcp__assistant__start_task', input: { title: 'x', prompt: 'y' } }))
    said(t.projector, 'On it.')
    t.projector.end()
    expect(t.activities()).toEqual([])
  })
})

function activityOf(): Activity {
  return { id: 'w1', taskId: 'aw-w1', title: 'Check files', summary: 'Working…', status: 'running', startedAt: 1, steps: [] }
}

function worker() {
  const seen: Activity[] = []
  let n = 0
  const projector = new ActivityProjector(activityOf(), (a) => seen.push(a), () => `s${++n}`, () => 5, '/work')
  return { projector, last: () => seen.at(-1)! }
}

describe('ActivityProjector (one worker)', () => {
  it("names steps off the calls themselves: Claude's description, the command, the path", () => {
    const w = worker()
    w.projector.part(p({ type: 'tool-call', toolCallId: 'a', toolName: 'Bash', input: { command: 'ls', description: 'List the files' } }))
    w.projector.part(p({ type: 'tool-call', toolCallId: 'b', toolName: 'exec', input: { command: '/bin/zsh -lc "find . -name \'*.txt\'"' } }))
    w.projector.part(p({ type: 'tool-call', toolCallId: 'c', toolName: 'read', input: { filePath: '/work/notes/a.md' } }))
    w.projector.part(p({ type: 'tool-call', toolCallId: 'd', toolName: 'mcp__node_repl__js', input: JSON.stringify({ code: '1' }) }))
    expect(w.last().steps.map((s) => s.label)).toEqual(['List the files', "find . -name '*.txt'", 'read: notes/a.md', 'js'])
    expect(w.last().steps.map((s) => s.tool)).toEqual(['Bash', 'exec', 'read', 'js'])
  })

  it("leaves the assistant's own tools out of the steps", () => {
    const w = worker()
    for (const name of ['mcp__assistant_worker__finish_task', 'assistant_worker_report_progress', 'mcp__assistant_worker__heartbeat_done']) {
      w.projector.part(p({ type: 'tool-call', toolCallId: name, toolName: name, input: {} }))
    }
    w.projector.publish()
    expect(w.last().steps).toEqual([])
  })

  it('completes a step with what the tool returned, or fails it', () => {
    const w = worker()
    w.projector.part(p({ type: 'tool-call', toolCallId: 'a', toolName: 'Read', input: { file_path: '/work/a.txt' } }))
    w.projector.part(p({ type: 'tool-result', toolCallId: 'a', output: { content: [{ type: 'text', text: 'alpha' }] } }))
    w.projector.part(p({ type: 'tool-call', toolCallId: 'b', toolName: 'Bash', input: { command: 'curl x' } }))
    w.projector.part(p({ type: 'tool-error', toolCallId: 'b', error: new Error('blocked') }))
    expect(w.last().steps.map((s) => [s.status, s.result])).toEqual([['done', 'alpha'], ['failed', 'blocked']])
  })

  it('settles from finish_task, keeping the full result as the report', () => {
    const w = worker()
    said(w.projector, 'alpha.txt — alpha first line')
    w.projector.handIn({ tool: 'finish_task', args: { title: 'Listed files', summary: '2 files', status: 'partial' } })
    w.projector.turnEnd({})
    w.projector.settle('completed')
    expect(w.last()).toMatchObject({ status: 'partial', title: 'Listed files', summary: '2 files', report: '2 files\n\nalpha.txt — alpha first line' })
  })

  it('falls back to the final text when the worker never calls finish_task', () => {
    const w = worker()
    said(w.projector, 'Found:\nalpha.txt has one line')
    w.projector.turnEnd({})
    w.projector.settle('completed', 'Fallback title')
    expect(w.last()).toMatchObject({ status: 'done', title: 'Fallback title', summary: 'alpha.txt has one line' })
  })

  it('marks a stopped worker and its unfinished steps', () => {
    const w = worker()
    w.projector.part(p({ type: 'tool-call', toolCallId: 'a', toolName: 'Bash', input: { command: 'sleep 9' } }))
    w.projector.turnEnd({ aborted: true, error: 'aborted' })
    w.projector.settle('stopped')
    expect(w.last()).toMatchObject({ status: 'stopped', summary: 'Stopped' })
    expect(w.last().steps[0]!.status).toBe('failed')
  })

  it('fails a run whose turn failed, saying why', () => {
    const w = worker()
    w.projector.turnEnd({ error: '500 {"error":{"message":"upstream down"}}' })
    w.projector.settle('failed')
    expect(w.last()).toMatchObject({ status: 'failed', summary: '500 · upstream down' })
  })

  it('says so when a run ran out of time', () => {
    const w = worker()
    w.projector.settle('timed_out')
    expect(w.last()).toMatchObject({ status: 'failed', summary: 'Took too long and was stopped' })
  })

  it('flips a live worker to waiting and back, and leaves a finished one alone', () => {
    const w = worker()
    w.projector.setWaiting(true)
    expect(w.last().status).toBe('waiting')
    w.projector.setWaiting(false)
    expect(w.last().status).toBe('running')
    w.projector.settle('completed')
    w.projector.setWaiting(true)
    expect(w.last().status).toBe('done')
  })

  it('reopens the same activity when a finished task is continued, steps kept', () => {
    const w = worker()
    w.projector.part(p({ type: 'tool-call', toolCallId: 'a', toolName: 'Bash', input: { command: 'ls' } }))
    w.projector.settle('completed')
    w.projector.reopen()
    w.projector.note('also the .md files')
    expect(w.last()).toMatchObject({ status: 'running', summary: 'Working…' })
    expect(w.last().steps.map((s) => s.label)).toEqual(['ls', 'You: also the .md files'])
  })

  it('shows a reported milestone as a step', () => {
    const w = worker()
    w.projector.progress('Found the booking page')
    expect(w.last().steps[0]).toMatchObject({ label: 'Found the booking page', tool: 'report_progress', status: 'done' })
  })
})

describe('briefError', () => {
  it('keeps plain errors and boils JSON bodies down to status and message', () => {
    expect(briefError('socket hang up')).toBe('socket hang up')
    expect(briefError('402 {"error":{"message":"This request requires more credits"}}')).toBe('402 · This request requires more credits')
  })
})
