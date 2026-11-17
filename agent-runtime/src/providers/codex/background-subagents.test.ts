import { describe, expect, it, vi } from 'vitest'
import type { RuntimeBackgroundTask, RuntimeStreamPart } from '../../types.js'
import type { AppServerClient } from './sdk/app-server-client.js'
import { CodexBackgroundSubagents, codexSubagentTranscriptFrom, readCodexSubagentTranscript } from './background-subagents.js'
import { NotificationRouter } from './notification-router.js'
import { CodexTextStreamEmitter } from './text-stream-emitter.js'

// Notification shapes recorded from codex-cli 0.167: the parent spawns a
// sub-agent (`subAgentActivity` `started`), its turn ends, the sub-agent works
// on its own thread, and the parent gets a `completed` activity afterwards.

const PARENT = 'thread-parent'
const CHILD = 'thread-child'
const SPAWN = 'call_spawn'

const activity = (kind: 'started' | 'completed' | 'interrupted', id = kind === 'started' ? SPAWN : `subagent-${kind}-1`) => ({
  threadId: PARENT,
  turnId: 'turn-1',
  item: { type: 'subAgentActivity', id, kind, agentThreadId: CHILD, agentPath: '/root/run_sleep_ls', model: null, startedAtMs: 10, completedAtMs: 20 },
})
const childCommand = (phase: 'started' | 'completed') => ({
  threadId: CHILD,
  turnId: 'child-turn',
  item: {
    type: 'commandExecution', id: 'exec-1', command: 'sleep 1 && ls', cwd: '/w',
    status: phase === 'started' ? 'inProgress' : 'completed', ...(phase === 'completed' ? { aggregatedOutput: 'a.txt\n', exitCode: 0 } : {}),
  },
})

type Handler = (params: unknown) => void

function clientHarness() {
  const handlers = new Map<string, Set<Handler>>()
  const client = {
    onNotification(method: string, handler: Handler) {
      const set = handlers.get(method) ?? new Set<Handler>()
      set.add(handler)
      handlers.set(method, set)
      return () => set.delete(handler)
    },
    onRequest() {
      return () => undefined
    },
    request: vi.fn(),
  }
  return {
    client: client as unknown as AppServerClient,
    request: client.request,
    emit(method: string, params: unknown) {
      for (const handler of handlers.get(method) ?? []) handler(params)
    },
  }
}

describe('Codex background sub-agents', () => {
  it('tracks a sub-agent from its spawn to its completion, past the turn that spawned it', () => {
    const harness = clientHarness()
    const lists: RuntimeBackgroundTask[][] = []
    const tracker = new CodexBackgroundSubagents((threadId) => threadId === PARENT, (tasks) => lists.push(tasks))
    tracker.attach(harness.client)

    harness.emit('item/started', activity('started'))
    harness.emit('item/completed', activity('started'))
    expect(lists).toHaveLength(1)
    expect(lists[0]).toEqual([expect.objectContaining({
      taskId: CHILD, toolUseId: SPAWN, description: 'run sleep ls', status: 'running', backgrounded: true, toolUses: 0,
    })])

    harness.emit('turn/started', { threadId: CHILD, turn: { id: 'child-turn' } })
    harness.emit('item/started', childCommand('started'))
    expect(lists.at(-1)?.[0]).toMatchObject({ toolUses: 1, lastToolName: 'Bash' })
    expect(tracker.activeTurn(CHILD)).toBe('child-turn')

    harness.emit('item/completed', activity('completed'))
    expect(lists.at(-1)?.[0]).toMatchObject({ status: 'completed', endedAt: 20 })
    expect(tracker.activeTurn(CHILD)).toBeUndefined()

    tracker.clearFinished()
    expect(lists.at(-1)).toEqual([])
  })

  it('ignores activity on threads that are not this session\'s', () => {
    const harness = clientHarness()
    const onChange = vi.fn()
    new CodexBackgroundSubagents((threadId) => threadId === 'someone-else', onChange).attach(harness.client)
    harness.emit('item/completed', activity('started'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('draws the spawn as a sub-agent card that stays running when the turn ends before the sub-agent does', () => {
    const harness = clientHarness()
    const parts: RuntimeStreamPart[] = []
    const controller: ReadableStreamDefaultController<RuntimeStreamPart> = {
      desiredSize: null, enqueue: (part) => void parts.push(part), close: () => {}, error: () => {},
    }
    const router = new NotificationRouter(harness.client, new CodexTextStreamEmitter(controller, { threadId: PARENT, turnId: 'turn-1', modelId: 'gpt-5' }), {
      threadId: PARENT, turnId: 'turn-1', onTurnCompleted: () => undefined,
    })
    router.subscribe()
    harness.emit('item/started', activity('started'))
    harness.emit('item/completed', activity('started'))
    harness.emit('item/started', childCommand('started'))
    harness.emit('turn/completed', { threadId: PARENT, turn: { id: 'turn-1', status: 'completed' } })
    router.unsubscribe()

    expect(parts).toContainEqual(expect.objectContaining({
      type: 'tool-call', toolCallId: SPAWN, toolName: 'codex_collab_agent',
      input: JSON.stringify({ description: 'run sleep ls', agent_path: '/root/run_sleep_ls', run_in_background: true }),
    }))
    const progress = parts.flatMap((part) => part.type === 'tool-result' && part.toolCallId === SPAWN ? [part.output as { state: string; recentActivity: unknown[] }] : [])
    expect(progress.at(-1)).toMatchObject({ state: 'running', recentActivity: [expect.objectContaining({ id: 'exec-1', status: 'running' })] })
  })

  it('reads a sub-agent\'s steps from its thread, found through the parent\'s spawn item', async () => {
    const harness = clientHarness()
    harness.request.mockImplementation(async (_method: string, params: { threadId: string }) => params.threadId === PARENT
      ? { thread: { status: { type: 'idle' }, turns: [{ items: [activity('started').item, activity('completed').item] }] } }
      : { thread: { status: { type: 'idle' }, turns: [{ items: [{ type: 'agentMessage', id: 'm', text: 'ok' }, childCommand('completed').item] }] } })

    expect(await readCodexSubagentTranscript(harness.client, PARENT, SPAWN)).toEqual({
      finished: true,
      steps: [{ toolCallId: 'exec-1', toolName: 'Bash', input: { command: 'sleep 1 && ls', cwd: '/w' }, state: 'output-available', output: 'a.txt\n' }],
    })
    expect(harness.request).toHaveBeenCalledWith('thread/read', { threadId: CHILD, includeTurns: true })
    expect(await readCodexSubagentTranscript(harness.client, PARENT, 'call_other')).toBeNull()
  })

  it('reports a running sub-agent thread as unfinished and a failed command as an error', () => {
    expect(codexSubagentTranscriptFrom({
      thread: {
        status: { type: 'active' },
        turns: [{ items: [{ type: 'commandExecution', id: 'x', command: 'false', status: 'failed', exitCode: 1, aggregatedOutput: 'boom' }] }],
      },
    })).toEqual({
      finished: false,
      steps: [{ toolCallId: 'x', toolName: 'Bash', input: { command: 'false', cwd: undefined }, state: 'output-error', errorText: 'boom' }],
    })
  })
})
