import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { Agent } from '../../types/channel.js'
import type { SpecRun, SpecTicketBuild } from '../../types/spec.js'
import type { Task } from '../../types/task.js'

vi.mock('../workflow/dispatch.js', () => ({ runProviderAgent: vi.fn() }))
vi.mock('operon-agents', () => ({ LocalEnvironment: class {}, createWorktree: vi.fn(), newAgentId: () => 'a', validateValue: vi.fn() }))
vi.mock('../workflow/store.js', () => ({ appendEvent: vi.fn(), markExecuting: vi.fn(), unmarkExecuting: vi.fn(), readRunView: vi.fn() }))
vi.mock('../workflow/registry.js', () => ({ registerWorkflowAbort: vi.fn(), unregisterWorkflowAbort: vi.fn() }))
const completion = vi.hoisted(() => ({ deliverChatNotice: vi.fn(async () => true), deliverWorkflowResult: vi.fn() }))
vi.mock('../workflow/completion.js', () => completion)
vi.mock('../task-events.js', () => ({ broadcastTask: vi.fn() }))
const orchestrator = vi.hoisted(() => ({
  attachSpecCoordinator: vi.fn(() => null),
  detachTaskSession: vi.fn(async () => undefined),
  dispatchProjectTask: vi.fn(async () => undefined),
  landSpecTicket: vi.fn(),
  stopTaskSession: vi.fn(),
  wakeTaskBinding: vi.fn(async () => true),
}))
vi.mock('../channel/agent-orchestrator.js', () => orchestrator)
const notify = vi.hoisted(() => vi.fn())
vi.mock('../notification-service.js', () => ({ notify }))
const specService = vi.hoisted(() => ({
  SpecError: class SpecError extends Error {},
  specDesignChanged: vi.fn(async () => false),
  resumeSpec: vi.fn(async () => null),
}))
vi.mock('./spec-service.js', () => specService)
vi.mock('./review-run.js', () => ({ onAllTicketsMerged: vi.fn() }))
vi.mock('./design-run.js', () => ({ isDesignRunActive: vi.fn(() => false) }))

const { acceptSwitchProposal, dismissSwitchProposal, proposeSwitch, specSeats, switchSpecSeat } = await import('./switch.js')
const { setUsableProviderSource } = await import('./role-settings.js')
const { clearBuildSessions } = await import('./build-run.js')

const YOU = { type: 'human' as const, id: null, name: 'You' }

function entry(key: string, taskId: number, state: SpecTicketBuild['state']): SpecTicketBuild {
  return { key, taskId, implementer: 'codex', reviewer: 'claude-code', rounds: 1, state }
}

function makeStorage(stage: SpecRun['stage'] = 'building') {
  const spec = { id: 1, number: 7, projectId: 1, title: 'Snooze', workspaceId: 9, sourceChatId: 42, branchName: 'operon/task-7' } as Task
  const tasks = new Map<number, Task>([
    [101, { id: 101, number: 8, parentTaskId: 1, status: 'in_progress', blockedBy: [], workspaceId: 11, bindingId: 5, assignedAgentId: 50 } as unknown as Task],
    [102, { id: 102, number: 9, parentTaskId: 1, status: 'todo', blockedBy: [], assignedAgentId: 50 } as unknown as Task],
  ])
  let run = {
    taskId: 1,
    stage,
    config: {
      lead: { providerId: 'claude-code' },
      explorer: { providerId: 'codex' },
      candidates: [{ providerId: 'claude-code' }, { providerId: 'codex' }],
      judge: { providerId: 'claude-code' },
      builder: { providerId: 'claude-code' },
      implementer: { providerId: 'codex' },
      concurrency: 1,
    },
    designSha: 'signed',
    workflowRunId: 'spec-1',
    runIds: ['spec-1'],
    build: [entry('T1', 101, 'blocked'), entry('T2', 102, 'waiting')],
    rulings: [],
    error: null,
    proposal: null,
  } as unknown as SpecRun
  const agents = new Map<string, Agent>()
  const activity: { taskId: number; body?: string }[] = []
  const storage = {
    taskGet: (id: number) => (id === 1 ? spec : tasks.get(id) ?? null),
    taskUpdate: (id: number, patch: Partial<Task>) => Object.assign(id === 1 ? spec : (tasks.get(id) as Task), patch),
    taskAppendActivity: (taskId: number, a: { body?: string }) => activity.push({ taskId, ...a }),
    specRunGet: (id: number) => (id === 1 ? run : null),
    specRunUpdate: (_: number, patch: Partial<SpecRun>) => (run = { ...run, ...patch }),
    getWorkspace: (id: number) => ({ id, worktreePath: '/tmp/x' }),
    getBinding: () => null,
    getAgentByName: (name: string) => agents.get(name) ?? null,
    createAgent: (input: Partial<Agent>) => {
      const agent = { id: 60 + agents.size, ...input } as Agent
      agents.set(agent.name, agent)
      return agent
    },
    notificationMarkReadBySource: () => [],
  }
  return { storage: storage as never, spec, tasks, run: () => run, activity }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearBuildSessions()
  setUsableProviderSource(() => ['claude-code', 'codex', 'opencode'])
})

describe('the seats a person can switch', () => {
  it('lists every role, the automatic reviewer, and each open ticket\'s two seats', () => {
    const { run } = makeStorage()
    const seats = specSeats(run().config, run().build)
    expect(seats.find((s) => s.role === 'reviewer' && !s.ticketKey)).toMatchObject({ auto: true })
    expect(seats.filter((s) => s.role === 'candidate').map((s) => s.index)).toEqual([0, 1])
    expect(seats.filter((s) => s.ticketKey === 'T1').map((s) => [s.role, s.seat.providerId])).toEqual([
      ['implementer', 'codex'],
      ['reviewer', 'claude-code'],
    ])
  })
})

describe('switching a ticket\'s implementer', () => {
  it('takes it off its session and starts it again on the new agent, told to build on what is there', async () => {
    const { storage, tasks, run } = makeStorage()
    const said = await switchSpecSeat(storage, 1, { role: 'implementer', ticketKey: 'T1', to: { providerId: 'opencode', modelId: 'vendor/m' } }, YOU)
    expect(said).toContain('opencode · vendor/m')
    expect(orchestrator.detachTaskSession).toHaveBeenCalledWith(101)
    expect(tasks.get(101)!.assignedAgentId).not.toBe(50)
    expect(run().build[0]).toMatchObject({ implementer: 'opencode', implementerModelId: 'vendor/m', rounds: 0, state: 'building' })
    // A blocked ticket went to the front of the queue and started with the handover note.
    expect(orchestrator.dispatchProjectTask).toHaveBeenCalledWith(101, tasks.get(101)!.assignedAgentId, expect.stringContaining('another agent (codex)'))
    expect(run().build[0].handedOver).toBeUndefined()
  })

  it('refuses an agent that is not usable here', async () => {
    const { storage } = makeStorage()
    await expect(switchSpecSeat(storage, 1, { role: 'implementer', ticketKey: 'T1', to: { providerId: 'grok' } }, YOU)).rejects.toThrow(
      'not installed',
    )
  })
})

describe('a role of a stopped spec', () => {
  it('changes the seat and carries the spec on', async () => {
    const { storage, run } = makeStorage('failed')
    await switchSpecSeat(storage, 1, { role: 'judge', to: { providerId: 'opencode' } }, YOU)
    expect(run().config.judge).toEqual({ providerId: 'opencode' })
    expect(specService.resumeSpec).toHaveBeenCalledWith(storage, 1)
  })
})

describe('the coordinator\'s proposal', () => {
  it('asks the user in the spec\'s chat, and the switch happens when they say yes', async () => {
    const { storage, run, spec } = makeStorage()
    proposeSwitch(storage, spec, { role: 'reviewer', ticketKey: 'T1', to: { providerId: 'opencode' } }, 'claude-code is out of quota', 'Spec coordinator')
    expect(run().proposal).toMatchObject({ role: 'reviewer', ticketKey: 'T1', from: { providerId: 'claude-code' }, reason: 'claude-code is out of quota' })
    expect(completion.deliverChatNotice).toHaveBeenCalledWith(42, expect.stringContaining('<spec-notice spec="7">'), expect.anything(), expect.any(String))

    await acceptSwitchProposal(storage, 1, YOU)
    expect(run().proposal).toBeNull()
    expect(run().build[0]).toMatchObject({ reviewer: 'opencode' })
  })

  it('tells the coordinator when the user says no', async () => {
    const { storage, run, spec } = makeStorage()
    proposeSwitch(storage, spec, { role: 'implementer', ticketKey: 'T1', to: { providerId: 'opencode' } }, 'quota', 'Spec coordinator')
    await dismissSwitchProposal(storage, 1, YOU, 'wait until tomorrow')
    expect(run().proposal).toBeNull()
    expect(run().build[0].implementer).toBe('codex')
  })
})
