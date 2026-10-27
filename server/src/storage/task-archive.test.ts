import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SqliteStorage } from './sqlite.js'

// Run under Electron's Node to match the native SQLite ABI.
let storage: SqliteStorage
let projectId: number
beforeEach(() => {
  storage = new SqliteStorage(':memory:')
  projectId = storage.createProject({ name: 'Archive', rootPath: '/tmp/archive-test' }).id
})
afterEach(() => storage?.close())

function tree() {
  const parent = storage.taskCreate({ projectId, title: 'Parent' })
  const child = storage.taskCreate({ projectId, title: 'Child', parentTaskId: parent.id })
  const grandchild = storage.taskCreate({ projectId, title: 'Grandchild', parentTaskId: child.id })
  const sibling = storage.taskCreate({ projectId, title: 'Unrelated' })
  return { parent, child, grandchild, sibling }
}

describe('task archive cascade', () => {
  it('archives all descendants, keeps their statuses and leaves unrelated tasks alone', () => {
    const { parent, child, grandchild, sibling } = tree()
    storage.taskUpdate(child.id, { status: 'done' })
    storage.taskSetArchived(parent.id, true, { type: 'human', name: 'You' })
    const archivedAt = storage.taskGet(parent.id)?.archivedAt
    expect(archivedAt).toEqual(expect.any(Number))
    for (const task of [child, grandchild]) {
      expect(storage.taskGet(task.id)?.archivedAt).toBe(archivedAt)
      expect(storage.taskListActivity(task.id).filter((a) => a.meta?.event === 'task.archived')).toHaveLength(1)
    }
    expect(storage.taskGet(child.id)?.status).toBe('done')
    expect(storage.taskGet(sibling.id)?.archivedAt).toBeNull()
    expect(storage.taskList({ projectId }).map((t) => t.id)).toEqual([sibling.id])
  })

  it('preserves previously archived descendants and keeps them archived on restore', () => {
    const { parent, child, grandchild } = tree()
    storage.taskSetArchived(child.id, true)
    const original = storage.taskGet(child.id)?.archivedAt
    // A later stamp than the child's, as a real second archive would have.
    vi.spyOn(Date, 'now').mockReturnValue((original ?? 0) + 1000)
    storage.taskSetArchived(parent.id, true)
    storage.taskSetArchived(parent.id, true)
    vi.restoreAllMocks()
    expect(storage.taskGet(child.id)?.archivedAt).toBe(original)
    expect(storage.taskListActivity(child.id).filter((a) => a.meta?.event === 'task.archived')).toHaveLength(1)
    storage.taskSetArchived(parent.id, false)
    expect(storage.taskGet(parent.id)?.archivedAt).toBeNull()
    expect(storage.taskGet(child.id)?.archivedAt).toBe(original)
    expect(storage.taskGet(grandchild.id)?.archivedAt).not.toBeNull()
  })

  it('restores the descendants that were archived along with the task', () => {
    const { parent, child, grandchild, sibling } = tree()
    storage.taskSetArchived(sibling.id, true)
    storage.taskSetArchived(parent.id, true)
    storage.taskSetArchived(parent.id, false)
    for (const task of [parent, child, grandchild]) {
      expect(storage.taskGet(task.id)?.archivedAt).toBeNull()
      expect(storage.taskListActivity(task.id).filter((a) => a.meta?.event === 'task.unarchived')).toHaveLength(1)
    }
    expect(storage.taskGet(sibling.id)?.archivedAt).not.toBeNull()
  })

  it('restoring a child leaves its archived parent alone', () => {
    const { parent, child, grandchild } = tree()
    storage.taskSetArchived(parent.id, true)
    storage.taskSetArchived(child.id, false)
    expect(storage.taskGet(parent.id)?.archivedAt).not.toBeNull()
    expect(storage.taskGet(child.id)?.archivedAt).toBeNull()
    expect(storage.taskGet(grandchild.id)?.archivedAt).toBeNull()
  })

  it('archives a new child even when its parent was already archived', () => {
    const { parent } = tree()
    storage.taskSetArchived(parent.id, true)
    const child = storage.taskCreate({ projectId, title: 'Later child', parentTaskId: parent.id })
    storage.taskSetArchived(parent.id, true)
    expect(storage.taskGet(child.id)?.archivedAt).not.toBeNull()
    expect(storage.taskListActivity(parent.id).filter((a) => a.meta?.event === 'task.archived')).toHaveLength(1)
  })

  it('returns and broadcasts archived descendants through the archive endpoint', async () => {
    const { taskRoutes } = await import('../routes/task.js')
    const { onTaskEvent } = await import('../services/channel-bus.js')
    const { parent, child, grandchild } = tree()
    const events: number[] = []
    const unsubscribe = onTaskEvent(projectId, (event) => events.push(event.task.id))
    try {
      const response = await taskRoutes(storage).request(`/${parent.id}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true }) })
      expect(response.status).toBe(200)
      const body = await response.json() as { tasks: Array<{ id: number; archivedAt: number | null }> }
      expect(body.tasks.map((t) => t.id).sort()).toEqual([parent.id, child.id, grandchild.id].sort())
      expect(body.tasks.every((t) => t.archivedAt != null)).toBe(true)
      expect(events.sort()).toEqual([parent.id, child.id, grandchild.id].sort())
    } finally { unsubscribe() }
  })

  it('returns and broadcasts restored descendants through the archive endpoint', async () => {
    const { taskRoutes } = await import('../routes/task.js')
    const { onTaskEvent } = await import('../services/channel-bus.js')
    const { parent, child, grandchild } = tree()
    storage.taskSetArchived(parent.id, true)
    const events: number[] = []
    const unsubscribe = onTaskEvent(projectId, (event) => events.push(event.task.id))
    try {
      const response = await taskRoutes(storage).request(`/${parent.id}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: false }) })
      expect(response.status).toBe(200)
      const body = await response.json() as { tasks: Array<{ id: number; archivedAt: number | null }> }
      expect(body.tasks.map((t) => t.id).sort()).toEqual([parent.id, child.id, grandchild.id].sort())
      expect(body.tasks.every((t) => t.archivedAt == null)).toBe(true)
      expect(events.sort()).toEqual([parent.id, child.id, grandchild.id].sort())
    } finally { unsubscribe() }
  })
})
