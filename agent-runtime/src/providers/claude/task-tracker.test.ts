import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { RuntimeBackgroundTask } from '../../types.js'
import { ClaudeTaskTracker, isTaskMessage } from './task-tracker.js'

// Message shapes recorded from Claude Code 2.1 through the Agent SDK: a slow
// foreground Bash, then a Bash run with `run_in_background`.

const system = (fields: Record<string, unknown>) =>
  ({ type: 'system', session_id: 's', uuid: 'u', ...fields }) as unknown as SDKMessage

const bashCall = (id: string, command: string, background = false) =>
  ({
    type: 'assistant',
    parent_tool_use_id: null,
    session_id: 's',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'desc', ...(background ? { run_in_background: true } : {}) } }],
    },
  }) as unknown as SDKMessage

const toolResult = (id: string, content: unknown) =>
  ({
    type: 'user',
    parent_tool_use_id: null,
    session_id: 's',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  }) as unknown as SDKMessage

function track() {
  const snapshots: RuntimeBackgroundTask[][] = []
  const tracker = new ClaudeTaskTracker((tasks) => snapshots.push(tasks))
  const feed = (message: SDKMessage) => {
    tracker.observeToolBlocks(message)
    if (isTaskMessage(message)) tracker.handle(message)
  }
  return { tracker, snapshots, feed, latest: () => snapshots.at(-1) ?? [] }
}

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('ClaudeTaskTracker', () => {
  it('names a foreground command by its command line and keeps its result as output', async () => {
    const { tracker, feed, latest } = track()
    feed(bashCall('call-1', 'sleep 8 && echo slow-foreground'))
    feed(system({ subtype: 'task_started', task_id: 't1', tool_use_id: 'call-1', description: 'Sleep then print', is_backgrounded: false, task_type: 'local_bash' }))

    expect(latest()).toEqual([
      expect.objectContaining({ taskId: 't1', taskType: 'local_bash', backgrounded: false, command: 'sleep 8 && echo slow-foreground', description: 'Sleep then print', status: 'running' }),
    ])
    // Still running in the foreground: there is no file to tail.
    expect(await tracker.output('t1')).toBeNull()

    feed(toolResult('call-1', 'slow-foreground'))
    feed(system({ subtype: 'task_notification', task_id: 't1', tool_use_id: 'call-1', status: 'completed', output_file: '', summary: 'Sleep then print' }))

    expect(latest()[0]).toMatchObject({ status: 'completed', endedAt: expect.any(Number) })
    expect(await tracker.output('t1')).toBe('slow-foreground')
  })

  it('tails a background command\'s output file while it runs', async () => {
    dir = mkdtempSync(join(tmpdir(), 'task-tracker-'))
    const file = join(dir, 'b1.output')
    writeFileSync(file, 'tick 1\n')

    const { tracker, feed, latest } = track()
    feed(bashCall('call-2', 'for i in 1 2 3; do echo tick $i; sleep 2; done', true))
    // The level arrives before task_started for a task that starts in the background.
    feed(system({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'Loop ticks' }] }))
    feed(system({ subtype: 'task_started', task_id: 'b1', tool_use_id: 'call-2', description: 'Loop ticks', is_backgrounded: true, task_type: 'local_bash' }))
    feed(toolResult('call-2', `Command running in background with ID: b1. Output is being written to: ${file}`))

    expect(latest()).toEqual([
      expect.objectContaining({ taskId: 'b1', toolUseId: 'call-2', backgrounded: true, command: 'for i in 1 2 3; do echo tick $i; sleep 2; done', status: 'running' }),
    ])
    expect(await tracker.output('b1')).toBe('tick 1\n')
    appendFileSync(file, 'tick 2\n')
    expect(await tracker.output('b1')).toBe('tick 1\ntick 2\n')

    feed(system({ subtype: 'task_notification', task_id: 'b1', tool_use_id: 'call-2', status: 'completed', output_file: file, summary: 'Background command "Loop ticks" completed (exit code 0)' }))
    feed(system({ subtype: 'background_tasks_changed', tasks: [] }))
    expect(latest()).toEqual([expect.objectContaining({ taskId: 'b1', status: 'completed' })])

    // The CLI clears its temp directory when the session ends.
    rmSync(file)
    expect(await tracker.output('b1')).toBeNull()
  })

  it('picks up the output file when the call\'s result lands before task_started', async () => {
    dir = mkdtempSync(join(tmpdir(), 'task-tracker-'))
    const file = join(dir, 'b2.output')
    writeFileSync(file, 'early\n')

    const { tracker, feed } = track()
    feed(bashCall('call-3', 'npm run dev', true))
    feed(toolResult('call-3', [{ type: 'text', text: `Output is being written to: ${file}` }]))
    feed(system({ subtype: 'task_started', task_id: 'b2', tool_use_id: 'call-3', description: 'Dev server', is_backgrounded: true, task_type: 'local_bash' }))

    expect(await tracker.output('b2')).toBe('early\n')
  })

  it('dates a foreground command from its tool call, not from when the CLI registered it', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    try {
      const { feed, latest } = track()
      feed(bashCall('call-5', 'sleep 6'))
      vi.advanceTimersByTime(3000)
      feed(system({ subtype: 'task_started', task_id: 's1', tool_use_id: 'call-5', description: 'Sleep', is_backgrounded: false, task_type: 'local_bash' }))
      expect(latest()[0].startedAt).toBe(1_000_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('follows a foreground task moved to the background', () => {
    const { feed, latest } = track()
    feed(system({ subtype: 'task_started', task_id: 'a1', tool_use_id: 'call-4', description: 'Review', is_backgrounded: false, task_type: 'local_agent' }))
    feed(system({ subtype: 'task_updated', task_id: 'a1', patch: { is_backgrounded: true } }))
    expect(latest()[0]).toMatchObject({ taskId: 'a1', backgrounded: true })
  })

  it('leaves out housekeeping tasks', () => {
    const { feed, snapshots } = track()
    feed(system({ subtype: 'task_started', task_id: 'h1', description: 'watch', task_type: 'monitor', ambient: true }))
    feed(system({ subtype: 'task_started', task_id: 'h2', description: 'x', task_type: 'local_bash', skip_transcript: true }))
    feed(system({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'h1', task_type: 'monitor', description: 'watch', ambient: true }] }))
    expect(snapshots).toEqual([])
  })

  it('clears finished tasks and keeps running ones', () => {
    const { tracker, feed, latest } = track()
    feed(system({ subtype: 'task_started', task_id: 'r', description: 'running', task_type: 'local_bash', is_backgrounded: true }))
    feed(system({ subtype: 'task_started', task_id: 'd', description: 'done', task_type: 'local_bash', is_backgrounded: true }))
    feed(system({ subtype: 'task_notification', task_id: 'd', status: 'failed', output_file: '', summary: 'exit 1' }))

    tracker.clearFinished()
    expect(latest().map((task) => task.taskId)).toEqual(['r'])
  })
})
