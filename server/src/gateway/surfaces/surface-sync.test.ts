import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task, TaskSurface, TaskSurfaceInput } from '../../types/task.js'

const h = vi.hoisted(() => ({
  createIssue: vi.fn(),
  listeners: [] as Array<(task: unknown) => void>,
}))

vi.mock('../../services/integrations/linear-app.js', () => ({
  createLinearIssue: h.createIssue,
  createLinearComment: vi.fn(),
  fetchLinearTeamDetails: vi.fn(async () => ({ states: [] })),
  updateLinearIssue: vi.fn(async () => undefined),
}))
vi.mock('../../services/integration-config.js', () => ({
  getLinearAppConfig: () => ({ orgId: 'org', appUserId: 'agent-user', linearUserName: 'Me' }),
  getLinearPublishTeam: () => null,
  rememberLinearPublishTeam: vi.fn(),
}))
vi.mock('../../services/integrations/project-repos.js', () => ({ claimRoute: vi.fn() }))
vi.mock('../../services/task-events.js', () => ({
  broadcastTask: vi.fn(),
  registerTaskBroadcastListener: (l: (task: unknown) => void) => h.listeners.push(l),
}))
vi.mock('../../services/notification-service.js', () => ({ notifyTaskStatusChange: vi.fn() }))
vi.mock('../../services/channel/agent-orchestrator.js', () => ({
  completeTaskAfterHumanReview: vi.fn(),
  maybeAutoDispatchTask: vi.fn(),
  maybeAutoIntegrate: vi.fn(),
}))
vi.mock('./task-surface-bridge.js', () => ({ announceToSurfaces: vi.fn() }))

const { initSurfaceSync, publishTaskToLinear } = await import('./surface-sync.js')

let tasks: Task[]
let surfaces: TaskSurface[]

function task(id: number, parentTaskId: number | null, extra: Partial<Task> = {}): Task {
  return {
    id,
    number: id,
    projectId: 1,
    title: `Task ${id}`,
    description: '',
    status: 'todo',
    priority: 'none',
    parentTaskId,
    archivedAt: null,
    ...extra,
  } as Task
}

const fakeStorage = {
  taskGet: (id: number) => tasks.find((t) => t.id === id) ?? null,
  taskListChildren: (id: number) => tasks.filter((t) => t.parentTaskId === id),
  taskSurfaceList: (taskId: number) => surfaces.filter((s) => s.taskId === taskId),
  taskSurfaceFind: (kind: string, externalId: string) =>
    surfaces.find((s) => s.kind === kind && s.externalId === externalId) ?? null,
  taskSurfaceUpsert: (input: TaskSurfaceInput) => {
    const hit = surfaces.find((s) => s.taskId === input.taskId && s.kind === input.kind)
    if (hit) {
      hit.meta = { ...hit.meta, ...input.meta }
      return hit
    }
    const row: TaskSurface = {
      id: surfaces.length + 1,
      taskId: input.taskId,
      kind: input.kind,
      externalId: input.externalId,
      url: input.url ?? null,
      meta: input.meta ?? null,
      createdAt: 0,
    }
    surfaces.push(row)
    return row
  },
  taskAppendActivity: vi.fn(),
}

/** Lets the fire-and-forget publishes started by a broadcast finish. */
const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  tasks = []
  surfaces = []
  h.listeners.length = 0
  h.createIssue.mockReset()
  let n = 0
  h.createIssue.mockImplementation(async (_org: string, input: { teamId: string; title: string }) => {
    n += 1
    return { id: `issue-${n}`, identifier: `ENG-${n}`, url: `https://linear.app/i/${n}`, title: input.title, teamId: input.teamId, projectId: null }
  })
  initSurfaceSync(fakeStorage as unknown as Parameters<typeof initSurfaceSync>[0])
})

describe('publishTaskToLinear with subtasks', () => {
  it('publishes the whole tree as sub-issues and skips cancelled subtasks', async () => {
    tasks = [task(1, null), task(2, 1), task(3, 1, { status: 'cancelled' }), task(4, 2)]

    const res = await publishTaskToLinear(tasks[0], { teamId: 'team' })

    expect(res.subtasks).toEqual({ published: 2, failed: 0 })
    const parentOf = (title: string) =>
      h.createIssue.mock.calls.find(([, input]) => input.title === title)?.[1].parentId
    expect(parentOf('Task 1')).toBeUndefined()
    const issueOf = (taskId: number) => surfaces.find((s) => s.taskId === taskId)?.externalId
    expect(parentOf('Task 2')).toBe(issueOf(1))
    expect(parentOf('Task 4')).toBe(issueOf(2))
    expect(issueOf(3)).toBeUndefined()
    expect(h.createIssue.mock.calls.every(([, input]) => input.teamId === 'team')).toBe(true)
  })

  it('publishes missing subtasks of an already-published task', async () => {
    tasks = [task(1, null)]
    await publishTaskToLinear(tasks[0], { teamId: 'team' })
    tasks.push(task(2, 1))

    const res = await publishTaskToLinear(tasks[0])

    expect(res.alreadyPublished).toBe(true)
    expect(res.subtasks).toEqual({ published: 1, failed: 0 })
    expect(h.createIssue).toHaveBeenCalledTimes(2)
  })

  it('a subtask broadcast racing the button opens one issue, not two', async () => {
    tasks = [task(1, null)]
    await publishTaskToLinear(tasks[0], { teamId: 'team' })
    tasks.push(task(2, 1))

    for (const l of h.listeners) l(tasks[1])
    for (const l of h.listeners) l(tasks[0])
    await publishTaskToLinear(tasks[0])
    await settle()

    expect(h.createIssue).toHaveBeenCalledTimes(2)
    expect(surfaces.filter((s) => s.taskId === 2)).toHaveLength(1)
  })

  it('counts a failed subtask and keeps going', async () => {
    tasks = [task(1, null), task(2, 1), task(3, 1)]
    const real = h.createIssue.getMockImplementation()!
    h.createIssue.mockImplementation(async (org: string, input: { title: string; teamId: string }) => {
      if (input.title === 'Task 2') throw new Error('boom')
      return real(org, input)
    })

    const res = await publishTaskToLinear(tasks[0], { teamId: 'team' })

    expect(res.subtasks).toEqual({ published: 1, failed: 1 })
    expect(surfaces.some((s) => s.taskId === 3)).toBe(true)
  })
})
