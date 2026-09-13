import { emitTaskEvent } from './channel-bus.js'
import type { TaskStorageAdapter } from '../storage/interface.js'
import type { Task } from '../types/task.js'

// Cross-project observers of "a task changed" (the Linear surface sync uses
// this to project status onto the issue). Broadcast is the one funnel every
// mutation path — REST, MCP, dispatch — already goes through.
const listeners: Array<(task: Task) => void> = []

export function registerTaskBroadcastListener(listener: (task: Task) => void): () => void {
  listeners.push(listener)
  return () => {
    const i = listeners.indexOf(listener)
    if (i >= 0) listeners.splice(i, 1)
  }
}

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
  for (const l of listeners) {
    try {
      l(task)
    } catch (err) {
      console.warn('[TaskEvents] broadcast listener failed:', err instanceof Error ? err.message : err)
    }
  }
}
