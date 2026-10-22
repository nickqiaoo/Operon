import type { NotificationStorageAdapter, TaskStorageAdapter } from '../storage/interface.js'
import type { Task, TaskActivity, UpdateTaskInput } from '../types/task.js'
import { isValidTaskTransition } from '../types/task.js'
import {
  completeTaskAfterHumanReview,
  maybeAutoDispatchTask,
  maybeAutoIntegrate,
  wakeTaskBinding,
} from './channel/agent-orchestrator.js'
import { broadcastTask } from './task-events.js'
import { notifyTaskStatusChange } from './notification-service.js'
import { mirrorHumanComment } from '../gateway/surfaces/surface-sync.js'

/**
 * What the user does to a board task — from the task UI (routes/task.ts), or through the personal
 * assistant on their behalf. One path, so both get the same gates and side effects: Done merges
 * first, in_progress starts the assignee, a comment wakes the task's agent.
 */

export type HumanTaskStorage = TaskStorageAdapter & NotificationStorageAdapter

export type HumanTaskResult = { ok: true } | { ok: false; status: 400 | 409; body: unknown }

export async function updateTaskAsHuman(
  storage: HumanTaskStorage,
  existing: Task,
  updates: UpdateTaskInput,
  actorName: string,
): Promise<HumanTaskResult> {
  const id = existing.id
  if (existing.specStage != null && updates.assignedAgentId !== undefined && updates.assignedAgentId !== existing.assignedAgentId) {
    return { ok: false, status: 409, body: { error: 'Use Switch agent in the Spec to change its coordinator' } }
  }
  if (updates.status !== undefined && !isValidTaskTransition(existing.status, updates.status)) {
    return { ok: false, status: 400, body: { error: `Invalid transition: ${existing.status} → ${updates.status}` } }
  }
  if (updates.status !== undefined) {
    // Human Done is the review sign-off. It performs the required merge first:
    // spec tickets merge into the change branch; ordinary tasks and spec parents
    // merge their branch into the default branch. Only then is the task marked done.
    if (updates.status === 'done') {
      const res = await completeTaskAfterHumanReview(id, { type: 'human', id: null, name: actorName })
      if (!res.ok) return { ok: false, status: 409, body: { error: res.reason } }
      notifyTaskStatusChange(storage, existing, 'done', existing.status)
      return { ok: true }
    }
  }
  storage.taskUpdate(id, updates, { type: 'human', name: actorName })
  broadcastTask(storage, id)
  if (updates.status !== undefined) {
    // Inbox: human moved the task (e.g. → in_review, cancelled).
    notifyTaskStatusChange(storage, existing, updates.status, existing.status)
  }
  // Moving a task to in_progress with an assignee should actually start it
  // running in its worktree — not just flip a DB field (guarded inside).
  if (updates.status === 'in_progress') {
    void maybeAutoDispatchTask(id).catch((err) => console.error('[Task] auto-dispatch after update failed:', err))
  } else if (updates.status === 'in_review') {
    // Review-ready only; a spec ticket's reviewer starts here.
    void maybeAutoIntegrate(id, updates.status, { type: 'human', id: null, name: actorName }).catch((err) =>
      console.error('[Task] auto-integrate after update failed:', err),
    )
  }
  return { ok: true }
}

/** `actorName`: who wrote it, as given; unset reads as "You" on the task and "the human" to its agent. */
export function commentOnTaskAsHuman(
  storage: HumanTaskStorage,
  task: Task,
  body: string,
  actorName?: string,
): { activity: TaskActivity; woke: boolean } {
  const name = actorName || 'You'
  const activity = storage.taskAppendActivity(task.id, { kind: 'comment', actorType: 'human', actorName: name, body })
  broadcastTask(storage, task.id)
  // The same note shows up on the Linear issue, if the task has one.
  mirrorHumanComment(task.id, name, body)

  // Wake the task's agent so a human comment steers the running turn (or
  // resurrects an idle session) — the local analog of Linear's "post a
  // comment to resurrect the session". Fire-and-forget so the comment lands
  // instantly; the agent's reply arrives via the activity feed. Only tasks
  // that have been dispatched (bindingId set) have a session to wake.
  let woke = false
  if (task.bindingId != null) {
    const commenter = actorName || 'the human'
    const notification =
      `[New comment on task #${task.number} from ${commenter}]: ${body.trim()}\n` +
      `Re-read the full task with get_project_task(task: ${task.number}) if you need context, ` +
      `then continue the work or reply with comment_project_task(task: ${task.number}, body: "...").`
    woke = true
    void wakeTaskBinding(task.bindingId, notification).catch((err) => {
      console.warn(`[Task] wake-on-comment failed for task=${task.id}:`, err)
    })
  }
  return { activity, woke }
}
