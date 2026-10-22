import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskDetail } from '@/types/task'

const mocks = vi.hoisted(() => ({
  taskSetArchived: vi.fn(), taskList: vi.fn(), taskGet: vi.fn(), setWorkspaceTaskArchived: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ api: mocks }))
vi.mock('@/lib/analytics', () => ({ trackEvent: vi.fn() }))
vi.mock('@/stores/project-store', () => ({
  useProjectStore: { getState: () => ({ setWorkspaceTaskArchived: mocks.setWorkspaceTaskArchived }) },
}))

import { useTaskStore } from './task-store'

function task(id: number, parentTaskId: number | null = null, archivedAt: number | null = null): TaskDetail {
  return {
    id, projectId: 1, number: id, title: `Task ${id}`, description: '', status: 'todo', priority: 0,
    assignedAgentId: null, parentTaskId, sourceChannelId: null, sourceMessageId: null,
    branchName: null, workspaceId: null, bindingId: null, specStage: null, blockedBy: null,
    createdBy: 'human', archivedAt, createdAt: 0, updatedAt: 0,
    labels: [], activity: [], children: [], surfaces: [],
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  useTaskStore.setState({ tasks: [task(1), task(2, 1), task(3, 2), task(4)], detail: task(1) })
})

describe('task archive responses', () => {
  it('applies a cascading response without additional requests', async () => {
    const tasks = [task(1, null, 100), task(2, 1, 100), task(3, 2, 100)]
    mocks.taskSetArchived.mockResolvedValue({ task: tasks[0], tasks })
    await useTaskStore.getState().setArchived(1, true)
    expect(useTaskStore.getState().tasks.map((t) => t.archivedAt)).toEqual([100, 100, 100, null])
    expect(mocks.taskList).not.toHaveBeenCalled()
    expect(mocks.setWorkspaceTaskArchived).toHaveBeenCalledTimes(3)
  })

  it('finishes the entire cascade when an older server returns only task', async () => {
    const savedParent = task(1, null, 100)
    mocks.taskSetArchived.mockResolvedValue({ task: savedParent })
    mocks.taskList.mockResolvedValueOnce({ tasks: [savedParent, task(2, 1), task(3, 2), task(4)] })
      .mockResolvedValueOnce({ tasks: [savedParent, task(2, 1, 101), task(3, 2, 102), task(4)] })
    mocks.taskGet.mockResolvedValue({ task: { ...savedParent, children: [task(2, 1, 101)] } })

    await useTaskStore.getState().setArchived(1, true)

    expect(mocks.taskSetArchived.mock.calls).toEqual([[1, true], [2, true], [3, true]])
    expect(mocks.taskList).toHaveBeenCalledWith(1, { includeArchived: true })
    expect(useTaskStore.getState().tasks.map((t) => t.archivedAt)).toEqual([100, 101, 102, null])
    expect(useTaskStore.getState().detail?.children[0].archivedAt).toBe(101)
  })

  it('does not restore descendants or overwrite prior archives with an older response', async () => {
    useTaskStore.setState({ tasks: [task(1, null, 100), task(2, 1, 90), task(3, 2, 90), task(4)] })
    mocks.taskSetArchived.mockResolvedValue({ task: task(1) })
    mocks.taskList.mockResolvedValue({ tasks: [task(1), task(2, 1, 90), task(3, 2, 90), task(4)] })

    await useTaskStore.getState().setArchived(1, false)

    expect(mocks.taskSetArchived.mock.calls).toEqual([[1, false]])
    expect(useTaskStore.getState().tasks.map((t) => t.archivedAt)).toEqual([null, 90, 90, null])
  })

  it('rolls back the optimistic subtree if the archive request fails', async () => {
    mocks.taskSetArchived.mockRejectedValue(new Error('Connection failed'))
    await expect(useTaskStore.getState().setArchived(1, true)).rejects.toThrow('Connection failed')
    expect(useTaskStore.getState().tasks.every((t) => t.archivedAt == null)).toBe(true)
    expect(mocks.setWorkspaceTaskArchived).not.toHaveBeenCalled()
  })
})
