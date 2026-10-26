import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskDetail } from '@/types/task'

const mocks = vi.hoisted(() => ({ taskGet: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: mocks }))
vi.mock('@/lib/analytics', () => ({ trackEvent: vi.fn() }))
vi.mock('@/stores/project-store', () => ({ useProjectStore: { getState: () => ({}) } }))

import { useTaskStore } from './task-store'

function task(id: number): TaskDetail {
  return {
    id, projectId: 1, number: id, title: `Task ${id}`, description: '', status: 'todo', priority: 0,
    assignedAgentId: null, parentTaskId: null, sourceChannelId: null, sourceMessageId: null,
    branchName: null, workspaceId: null, bindingId: null, specStage: null, blockedBy: null,
    createdBy: 'human', archivedAt: null, createdAt: 0, updatedAt: 0,
    labels: [], activity: [], children: [], surfaces: [],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetAllMocks()
  useTaskStore.setState({ tasks: [], detail: null, detailPending: null })
})

describe('openDetail', () => {
  it('marks the task pending from the tap until its detail arrives', async () => {
    const reply = deferred<{ task: TaskDetail }>()
    mocks.taskGet.mockReturnValue(reply.promise)
    const opening = useTaskStore.getState().openDetail(1)
    expect(useTaskStore.getState().detailPending).toEqual({ id: 1, error: null })
    reply.resolve({ task: task(1) })
    await opening
    expect(useTaskStore.getState().detail?.id).toBe(1)
    expect(useTaskStore.getState().detailPending).toBeNull()
  })

  it('drops a detail that arrives after the page was closed', async () => {
    const reply = deferred<{ task: TaskDetail }>()
    mocks.taskGet.mockReturnValue(reply.promise)
    const opening = useTaskStore.getState().openDetail(1)
    useTaskStore.getState().closeDetail()
    reply.resolve({ task: task(1) })
    await opening
    expect(useTaskStore.getState().detail).toBeNull()
    expect(useTaskStore.getState().detailPending).toBeNull()
  })

  it('keeps only the last of two quick taps', async () => {
    const first = deferred<{ task: TaskDetail }>()
    mocks.taskGet.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ task: task(2) })
    const opening = useTaskStore.getState().openDetail(1)
    await useTaskStore.getState().openDetail(2)
    first.resolve({ task: task(1) })
    await opening
    expect(useTaskStore.getState().detail?.id).toBe(2)
  })

  it('leaves the error on the pending page instead of rejecting', async () => {
    mocks.taskGet.mockRejectedValue(new Error('timeout'))
    await expect(useTaskStore.getState().openDetail(1)).resolves.toBeUndefined()
    expect(useTaskStore.getState().detailPending).toEqual({ id: 1, error: 'timeout' })
  })
})
