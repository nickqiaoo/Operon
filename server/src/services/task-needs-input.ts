// A board task whose agent is blocked on a person reads as Needs Input.
//
// Every "the agent is waiting for you" request (tool approval, AskUserQuestion,
// plan review, a sub-agent's forwarded request) is registered per chat in
// chat-pending-input.ts. A task's session runs in its binding's active chat, so
// the first request there moves an in_progress task to needs_input, and once
// nothing is left pending it goes back to in_progress. Agents can also set
// needs_input themselves (a decision asked for in a comment); those are left
// alone here and return to work when the session wakes again (sqlite
// updateBinding) or a person moves the card.
//
// Which needs_input was set here is read off the activity feed (the status row's
// actor), not kept in memory, so a restart can tell them apart: the blocked turn
// died with the process, so the automatic ones go back to in_progress then.

import type { AgentBindingStorageAdapter, NotificationStorageAdapter, TaskStorageAdapter } from '../storage/interface.js'
import type { Task, TaskActor } from '../types/task.js'
import { subscribePendingInput } from './ai/chat-pending-input.js'
import { emitInboxEvent } from './channel-bus.js'
import { emitCounts, notifyTaskStatusChange } from './notification-service.js'
import { broadcastTask } from './task-events.js'

type Storage = TaskStorageAdapter & AgentBindingStorageAdapter & NotificationStorageAdapter

const ACTOR: TaskActor = { type: 'system', name: 'Pending input' }

let stopPending: (() => void) | null = null
let stopTasks: (() => void) | null = null

function taskOfChat(storage: Storage, chatId: number): Task | null {
  const binding = storage.getBindingByActiveChatId(chatId)
  if (!binding || binding.scopeKind !== 'task') return null
  const task = storage.taskGet(Number(binding.scopeKey))
  return task && task.bindingId === binding.id && task.archivedAt == null ? task : null
}

/** The task's current needs_input was set by this module, not by its agent or a person. */
export function isAutoNeedsInput(storage: Pick<TaskStorageAdapter, 'taskListActivity'>, taskId: number): boolean {
  const activity = storage.taskListActivity(taskId)
  for (let i = activity.length - 1; i >= 0; i--) {
    const row = activity[i]
    if (row.kind !== 'status') continue
    return row.actorType === ACTOR.type && row.actorName === ACTOR.name && row.meta?.to === 'needs_input'
  }
  return false
}

function move(storage: Storage, task: Task, status: 'needs_input' | 'in_progress'): void {
  storage.taskUpdate(task.id, { status }, ACTOR)
  broadcastTask(storage, task.id)
  notifyTaskStatusChange(storage, task, status, task.status)
}

/** The task's "needs your input" row stops asking once the task is no longer waiting. */
function settle(storage: Storage, taskId: number): void {
  try {
    const changed = storage.notificationSettleNeedsInput(`task:${taskId}`, { markRead: true })
    for (const id of changed) {
      const row = storage.notificationGet(id)
      if (row) emitInboxEvent({ type: 'notification_upsert', notification: row })
    }
    if (changed.length > 0) emitCounts(storage)
  } catch (err) {
    console.error('[TaskNeedsInput] settling the inbox row failed:', err)
  }
}

export function initTaskNeedsInput(storage: Storage): void {
  stopPending?.()
  stopTasks?.()

  for (const task of storage.taskList({ status: 'needs_input', includeArchived: true })) {
    if (isAutoNeedsInput(storage, task.id)) move(storage, task, 'in_progress')
  }

  stopTasks = storage.onTaskChange((before, after) => {
    if (before.status === 'needs_input' && after.status !== 'needs_input') settle(storage, after.id)
  })

  stopPending = subscribePendingInput((change) => {
    const task = taskOfChat(storage, change.chatId)
    if (!task) return
    if (change.reason === 'requested') {
      if (task.status === 'in_progress') move(storage, task, 'needs_input')
      return
    }
    if (change.pending.length > 0 || task.status !== 'needs_input') return
    if (isAutoNeedsInput(storage, task.id)) move(storage, task, 'in_progress')
  })
}
