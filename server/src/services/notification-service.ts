// Inbox notification service — the single entry point emit sites call when
// something finishes or needs the user. Wraps the storage upsert and pushes the
// live SSE echo. Best-effort: never throws into the caller's hot path (a chat
// turn finishing or a task status change must not fail because the inbox did).

import type { NotificationStorageAdapter } from '../storage/interface.js'
import type { NotificationKind, NotificationSeverity, NotifyInput } from '../types/notification.js'
import type { TaskStatus } from '../types/task.js'
import { emitInboxEvent } from './channel-bus.js'
import { relayPush } from './push-relay.js'

/**
 * Record (or coalesce) a notification and broadcast it to all connected inbox
 * streams. Same sourceKey → updates the existing live row and re-unreads it.
 */
export function notify(storage: NotificationStorageAdapter, input: NotifyInput): void {
  try {
    const notification = storage.notificationUpsert(input)
    emitInboxEvent({ type: 'notification_upsert', notification })
    emitCounts(storage)
    // Same event, second delivery path: the SSE echo above only reaches clients
    // that are currently connected, and the whole point of the phone app is to
    // be told when you are *not* looking at it. Note this is a strictly smaller
    // set than the inbox — relayPush drops everything that is not 'action', and
    // `push: false` lets a caller keep the row accurate without buzzing again
    // for a source the user has already been told about.
    if (input.push !== false) {
      relayPush({
        severity: notification.severity,
        sourceKey: notification.sourceKey,
        title: notification.title,
        body: notification.body ?? undefined,
        chatId: notification.chatId ?? undefined,
        taskId: notification.taskId ?? undefined,
        projectId: notification.projectId ?? undefined,
        workspaceId: notification.workspaceId ?? undefined,
        kind: notification.kind,
      })
    }
  } catch (err) {
    console.error('[Inbox] notify failed:', err)
  }
}

/**
 * Emit an inbox notification for a task status transition, if the new status is
 * one the user cares about (agent finished → in_review, or a task closing out →
 * done / cancelled). No-op for todo/in_progress or a same-status write. The
 * caller passes the pre-update status so we only fire on a real transition.
 */
export function notifyTaskStatusChange(
  storage: NotificationStorageAdapter,
  task: { id: number; projectId: number; number: number; title: string },
  newStatus: TaskStatus,
  prevStatus: TaskStatus,
): void {
  if (newStatus === prevStatus) return
  let kind: NotificationKind
  let severity: NotificationSeverity
  let verb: string
  switch (newStatus) {
    case 'in_review':
      kind = 'task_in_review'
      severity = 'action'
      verb = 'Ready for review'
      break
    case 'done':
      kind = 'task_done'
      severity = 'info'
      verb = 'Done'
      break
    case 'cancelled':
      kind = 'task_failed'
      severity = 'info'
      verb = 'Cancelled'
      break
    default:
      return
  }
  notify(storage, {
    kind,
    severity,
    sourceKey: `task:${task.id}`,
    projectId: task.projectId,
    taskId: task.id,
    title: task.title,
    body: `${verb} · #${task.number}`,
  })
}

/** Broadcast a fresh unread-counts snapshot (drives the bell badge). */
export function emitCounts(storage: NotificationStorageAdapter): void {
  try {
    const { total, action } = storage.notificationUnreadCounts()
    emitInboxEvent({ type: 'counts', total, action })
  } catch (err) {
    console.error('[Inbox] emitCounts failed:', err)
  }
}
