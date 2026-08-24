import { emitTaskEvent } from './channel-bus.js'
import type { TaskStorageAdapter } from '../storage/interface.js'

/**
 * Broadcast a task's current state to live subscribers (board + open detail).
 * Call after every task mutation — human (REST) or agent (MCP bridge / dispatch)
 * — so all windows converge. The frontend upserts the list row and, if the
 * task's detail is open, refetches it to pick up new activity-feed rows.
 */
export function broadcastTask(storage: TaskStorageAdapter, taskId: number): void {
  const task = storage.taskGet(taskId)
  if (!task) return
  const labels = storage.taskGetLabels(taskId)
  emitTaskEvent(task.projectId, { type: 'task_upsert', task: { ...task, labels } })
}
