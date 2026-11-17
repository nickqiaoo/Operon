import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent, HarnessSession } from 'operon-agents'
import type { RuntimeBackgroundTask } from '@operon/agent-runtime'
import { OperonBackgroundSubagents, operonSubagentStepsFrom, readOperonSubagentTranscript } from './background-subagents.js'

type TaskInfo = ReturnType<NonNullable<HarnessSession['background']>['list']>[number]
type AgentRecord = Awaited<ReturnType<HarnessSession['getRecords']>>[number]

const ADDRESS = 'main/agent-1'

function agentTask(overrides: Partial<Extract<TaskInfo, { kind: 'agent' }>> = {}): TaskInfo {
  return {
    kind: 'agent', taskId: 'task-1', agentId: 'agent-1', subagentType: 'general', toolCallId: 'call-1',
    description: 'Check the build', status: 'running', startedAt: 100, endedAt: null, ...overrides,
  } as TaskInfo
}

function fakeHarness(initial: TaskInfo[]) {
  let tasks = initial
  const listeners = new Set<(event: AgentEvent) => void>()
  const records: AgentRecord[] = [
    { type: 'context.append_message', address: ADDRESS, message: { role: 'user', content: 'Check the build', timestamp: 1 } },
    {
      type: 'context.append_message', address: ADDRESS,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Running it' }, { type: 'toolCall', id: 'bash-1', name: 'Bash', arguments: { command: 'make' } }] },
    },
    { type: 'context.append_message', address: ADDRESS, message: { role: 'toolResult', toolCallId: 'bash-1', toolName: 'Bash', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 2 } },
    {
      type: 'context.append_message', address: ADDRESS,
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'read-1', name: 'Read', arguments: { path: 'x' } }] },
    },
    { type: 'context.append_message', address: ADDRESS, message: { role: 'toolResult', toolCallId: 'read-1', toolName: 'Read', content: [{ type: 'text', text: 'missing' }], isError: true, timestamp: 3 } },
  ] as unknown as AgentRecord[]
  const harness = {
    onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    background: {
      // Like the real manager: a task leaves the list once it settles.
      list: vi.fn(() => tasks.filter((task) => task.status === 'running' || task.status === 'paused')),
      listSubagents: vi.fn(() => [{ agentId: 'agent-1', type: 'general', address: ADDRESS, background: true, status: 'running', createdAt: 1, updatedAt: 1 }]),
    },
    getRecords: vi.fn(async (address?: string) => (address === ADDRESS ? records : [])),
  }
  return {
    harness: harness as unknown as HarnessSession,
    getRecords: harness.getRecords,
    listeners,
    setTasks(next: TaskInfo[]) {
      tasks = next
    },
    emit(event: Partial<AgentEvent> & { type: string }) {
      for (const listener of listeners) listener({ address: 'main', ...event } as AgentEvent)
    },
  }
}

describe('Operon background sub-agents', () => {
  it('reports a background agent\'s status and steps as the task list its card reads', () => {
    const fake = fakeHarness([agentTask()])
    const lists: RuntimeBackgroundTask[][] = []
    const tracker = new OperonBackgroundSubagents(fake.harness, (tasks) => lists.push(tasks))
    tracker.start()

    fake.emit({ type: 'background.task.started', info: agentTask() })
    expect(lists.at(-1)).toEqual([{
      taskId: 'task-1', toolUseId: 'call-1', taskType: 'agent:general', backgrounded: true,
      description: 'Check the build', status: 'running', startedAt: 100,
    }])

    // A step taken by the agent — or by one it spawned in turn.
    fake.emit({ type: 'tool.call.started', address: ADDRESS, toolName: 'Bash', toolCallId: 'bash-1' } as Partial<AgentEvent> & { type: string })
    fake.emit({ type: 'tool.call.started', address: `${ADDRESS}/nested`, toolName: 'Read', toolCallId: 'read-1' } as Partial<AgentEvent> & { type: string })
    // The parent's own steps do not count.
    fake.emit({ type: 'tool.call.started', address: 'main', toolName: 'Edit', toolCallId: 'edit-1' } as Partial<AgentEvent> & { type: string })
    expect(lists.at(-1)?.[0]).toMatchObject({ toolUses: 2, lastToolName: 'Read' })

    fake.setTasks([])
    fake.emit({ type: 'background.task.terminated', info: agentTask({ status: 'completed', endedAt: 200, result: 'Build is green' }) })
    expect(lists.at(-1)?.[0]).toMatchObject({ status: 'completed', endedAt: 200, summary: 'Build is green' })

    tracker.stop()
    expect(fake.listeners.size).toBe(0)
  })

  it('leaves out commands and other non-agent tasks', () => {
    const fake = fakeHarness([agentTask(), { kind: 'command', taskId: 'cmd-1', toolCallId: 'call-2', description: 'npm test', status: 'running', startedAt: 1, endedAt: null } as unknown as TaskInfo])
    const tracker = new OperonBackgroundSubagents(fake.harness, () => {})
    expect(tracker.list().map((task) => task.taskId)).toEqual(['task-1'])
  })

  it('maps terminal statuses onto the runtime\'s', () => {
    const fake = fakeHarness([])
    const tracker = new OperonBackgroundSubagents(fake.harness, () => {})
    tracker.start()
    const statusOf = (status: TaskInfo['status']) => {
      fake.emit({ type: 'background.task.terminated', info: agentTask({ status }) })
      return tracker.list()[0]?.status
    }
    expect(statusOf('killed')).toBe('stopped')
    expect(statusOf('timed_out')).toBe('failed')
    expect(statusOf('lost')).toBe('failed')
    expect(statusOf('paused')).toBe('running')
  })

  it('reads a background agent\'s steps from its conversation shard', async () => {
    const fake = fakeHarness([])
    const tracker = new OperonBackgroundSubagents(fake.harness, () => {})
    tracker.start()
    fake.emit({ type: 'background.task.terminated', info: agentTask({ status: 'completed' }) })
    expect(await readOperonSubagentTranscript(fake.harness, tracker, 'call-1')).toEqual({
      finished: true,
      steps: [
        { toolCallId: 'bash-1', toolName: 'Bash', input: { command: 'make' }, state: 'output-available', output: 'ok' },
        { toolCallId: 'read-1', toolName: 'Read', input: { path: 'x' }, state: 'output-error', errorText: 'missing' },
      ],
    })
    expect(fake.getRecords).toHaveBeenCalledWith(ADDRESS)
    expect(await readOperonSubagentTranscript(fake.harness, tracker, 'call-unknown')).toBeNull()
  })

  it('keeps a step without a result as still running', () => {
    const steps = operonSubagentStepsFrom([
      { type: 'context.append_message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'Bash', arguments: {} }] } },
    ] as unknown as AgentRecord[])
    expect(steps).toEqual([{ toolCallId: 'a', toolName: 'Bash', input: {}, state: 'input-available' }])
  })
})

describe('Operon background sub-agents on a real harness', () => {
  it('follows an `Agent` launched with run_in_background past the turn that launched it', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { fauxAssistantMessage, fauxProvider, fauxToolCall } = await import('@earendil-works/pi-ai')
    const { createHarness, createModelManager } = await import('operon-agents')
    const { OperonRuntimeSession } = await import('./session.js')

    const workDir = await mkdtemp(join(tmpdir(), 'operon-bg-subagent-'))
    const handle = fauxProvider()
    const models = createModelManager({ builtins: false })
    models.models.setProvider(handle.provider)
    let releaseTool!: () => void
    const toolGate = new Promise<void>((resolve) => { releaseTool = resolve })
    let toolStarted!: () => void
    const toolRunning = new Promise<void>((resolve) => { toolStarted = resolve })
    const harness = createHarness({
      config: { defaults: { model: `${handle.provider.id}/${handle.getModel().id}`, permission: { mode: 'yolo' } }, workDir },
      modelManager: models,
      extensions: [{
        id: 'bg-subagent-test',
        session(api) {
          api.registerTool({
            name: 'SlowCheck',
            description: 'A slow check.',
            parameters: { type: 'object', properties: {} },
            execute: async () => {
              toolStarted()
              await toolGate
              return 'check passed'
            },
          })
        },
      }],
    })
    // One dispatcher per model request: the sub-agent's context starts with its own prompt.
    type FauxContext = { messages: Array<{ role: string; content: unknown }> }
    const isChild = (context: FauxContext) => JSON.stringify(context.messages).includes('SLOWTASK')
    const answered = (context: FauxContext) => context.messages.at(-1)?.role === 'toolResult'
    const dispatch = (context: FauxContext) => {
      if (isChild(context)) {
        return answered(context)
          ? fauxAssistantMessage('All good', { stopReason: 'stop' })
          : fauxAssistantMessage([fauxToolCall('SlowCheck', {})], { stopReason: 'toolUse' })
      }
      return answered(context)
        ? fauxAssistantMessage('LAUNCHED', { stopReason: 'stop' })
        : fauxAssistantMessage([fauxToolCall('Agent', { description: 'Slow check', prompt: 'SLOWTASK: run the slow check', run_in_background: true })], { stopReason: 'toolUse' })
    }
    handle.setResponses(Array.from({ length: 12 }, () => dispatch))

    try {
      const native = await harness.createSession()
      const session = new OperonRuntimeSession(native, 'test', 'yolo')
      const lists: RuntimeBackgroundTask[][] = []
      session.onBackground((event) => {
        if (event.type === 'tasks') lists.push(event.tasks)
      })

      const parts = []
      for await (const part of session.send('go')) parts.push(part)
      const spawn = parts.find((part) => part.type === 'tool-call' && part.toolName === 'Agent')
      expect(spawn).toBeDefined()
      const toolUseId = spawn && 'toolCallId' in spawn ? spawn.toolCallId : ''

      // The turn is over; the sub-agent is still in its slow tool.
      await toolRunning
      await vi.waitFor(() => expect(lists.at(-1)?.[0]).toMatchObject({ toolUseId, status: 'running', backgrounded: true, toolUses: 1, lastToolName: 'SlowCheck' }))

      releaseTool()
      await vi.waitFor(() => expect(lists.at(-1)?.[0]).toMatchObject({ status: 'completed' }))
      const transcript = await session.native.subagentTranscript(toolUseId)
      expect(transcript).toEqual({
        finished: true,
        steps: [expect.objectContaining({ toolName: 'SlowCheck', state: 'output-available', output: 'check passed' })],
      })
      await session.close()
    } finally {
      releaseTool()
      await harness.close()
      await rm(workDir, { recursive: true, force: true })
    }
  }, 20_000)
})
