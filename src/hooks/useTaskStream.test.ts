import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/stores/project-store'
import type { TaskListItem } from '@/types/task'

const mocks = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  projects: [] as Project[],
  loadProjects: vi.fn<() => Promise<void>>(),
  applyUpsert: vi.fn(),
  subscribeSse: vi.fn(),
  close: vi.fn(),
}))
vi.mock('react', () => ({ useEffect: (effect: () => void | (() => void)) => mocks.effects.push(effect) }))
vi.mock('@/lib/api', () => ({ api: { taskStreamUrl: vi.fn() } }))
vi.mock('@/lib/sse', () => ({ subscribeSse: mocks.subscribeSse }))
vi.mock('@/stores/task-store', () => ({
  useTaskStore: (select: (state: { applyUpsert: typeof mocks.applyUpsert }) => unknown) => select({ applyUpsert: mocks.applyUpsert }),
}))
vi.mock('@/stores/project-store', () => ({
  useProjectStore: { getState: () => ({ projects: mocks.projects, loadProjects: mocks.loadProjects }) },
}))

import { taskChangesProjectTree, useTaskStream } from './useTaskStream'

const task: TaskListItem = {
  id: 25, projectId: 1, number: 25, title: 'Reading time', description: '',
  status: 'in_progress', priority: 0, assignedAgentId: null, parentTaskId: null,
  sourceChannelId: null, sourceMessageId: null, branchName: 'spec-25', workspaceId: 2,
  bindingId: null, specStage: 'grounding', blockedBy: null, createdBy: 'agent',
  archivedAt: null, createdAt: 0, updatedAt: 0, labels: [],
}
const project: Project = {
  id: 1, name: 'Blog', rootPath: '/blog', createdAt: 0, updatedAt: 0,
  workspaces: [{ id: 2, name: 'Spec 25', branchName: 'spec-25', worktreePath: '/spec-25', task }],
  specs: [task],
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.effects = []
  mocks.projects = [project]
  mocks.loadProjects.mockResolvedValue()
  mocks.subscribeSse.mockReturnValue({ close: mocks.close })
})
afterEach(() => vi.useRealTimers())

function mount() {
  useTaskStream(null)
  const cleanup = mocks.effects[0]()
  const { onEvent } = mocks.subscribeSse.mock.calls[0][0] as { onEvent: (event: { type: 'task_upsert'; task: TaskListItem }) => void }
  return { cleanup, emit: (next: TaskListItem) => onEvent({ type: 'task_upsert', task: next }) }
}

describe('global task navigation sync', () => {
  it('ignores repeated snapshots and execution-only changes', async () => {
    const { emit, cleanup } = mount()
    emit({ ...task })
    emit({ ...task, updatedAt: 100, executionStatus: 'active' })
    await vi.runAllTimersAsync()
    expect(mocks.loadProjects).not.toHaveBeenCalled()
    expect(mocks.applyUpsert).toHaveBeenCalledTimes(2)
    cleanup?.()
  })

  it('coalesces a new Spec and its stage updates into one project refresh', async () => {
    const { emit, cleanup } = mount()
    emit({ ...task, id: 26, workspaceId: 3 })
    emit({ ...task, id: 26, workspaceId: 3, specStage: 'designing' })
    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.loadProjects).toHaveBeenCalledTimes(1)
    cleanup?.()
  })

  it('skips a queued refresh when the latest event matches the current tree', async () => {
    const { emit, cleanup } = mount()
    emit({ ...task, specStage: 'designing' })
    emit({ ...task })
    await vi.runAllTimersAsync()
    expect(mocks.loadProjects).not.toHaveBeenCalled()
    cleanup?.()
  })

  it('does not refetch when an in-flight response already contains the later event', async () => {
    let finish: () => void = () => {}
    mocks.loadProjects.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const { emit, cleanup } = mount()
    emit({ ...task, specStage: 'designing' })
    await vi.advanceTimersByTimeAsync(100)
    emit({ ...task, specStage: 'stopped' })
    mocks.projects = [{ ...project, workspaces: [{ ...project.workspaces[0], task: { ...task, specStage: 'stopped' } }] }]
    finish()
    await vi.runAllTimersAsync()
    expect(mocks.loadProjects).toHaveBeenCalledTimes(1)
    cleanup?.()
  })

  it('refreshes again when a later event is missing from the in-flight response', async () => {
    let finish: () => void = () => {}
    mocks.loadProjects.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const { emit, cleanup } = mount()
    emit({ ...task, specStage: 'designing' })
    await vi.advanceTimersByTimeAsync(100)
    emit({ ...task, specStage: 'stopped' })
    finish()
    await vi.runAllTimersAsync()
    expect(mocks.loadProjects).toHaveBeenCalledTimes(2)
    cleanup?.()
  })

  it('cancels queued refreshes and closes the subscription on unmount', async () => {
    const { emit, cleanup } = mount()
    emit({ ...task, specStage: 'stopped' })
    cleanup?.()
    await vi.runAllTimersAsync()
    expect(mocks.close).toHaveBeenCalledOnce()
    expect(mocks.loadProjects).not.toHaveBeenCalled()
  })

  it('refreshes on workspace creation or removal, but ignores ordinary tasks without a workspace', () => {
    expect(taskChangesProjectTree({ ...task, workspaceId: null }, [project])).toBe(true)
    expect(taskChangesProjectTree({ ...task, id: 26, workspaceId: 3 }, [project])).toBe(true)
    expect(taskChangesProjectTree({ ...task, id: 26, specStage: null, workspaceId: null }, [project])).toBe(false)
  })
})
