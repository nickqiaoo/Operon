// Inbox notification service — the single entry point emit sites call when
// something finishes or needs the user. Wraps the storage upsert and pushes the
// live SSE echo. Best-effort: never throws into the caller's hot path (a chat
// turn finishing or a task status change must not fail because the inbox did).

import type { NotificationStorageAdapter } from '../storage/interface.js'
import type { NotificationKind, NotificationSeverity, NotifyInput } from '../types/notification.js'
import type { TaskStatus } from '../types/task.js'
import { emitInboxEvent } from './channel-bus.js'
import { isChatBeingViewed } from './chat-viewers.js'
import { relayPush } from './push-relay.js'

/**
 * Record (or coalesce) a notification and broadcast it to all connected inbox
 * streams. Same sourceKey → updates the existing live row and re-unreads it.
 */
export function notify(storage: NotificationStorageAdapter, input: NotifyInput): void {
  // A turn that finished in front of the user is not news. Skipped rather than
  // written as read: otherwise every conversation still piles into the list.
  if ((input.kind === 'chat_complete' || input.kind === 'task_reply') && input.chatId != null && isChatBeingViewed(input.chatId)) {
    return
  }
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
      }, () => {
        // Held while the user was at the desktop: still worth a push only if
        // nobody has read, archived, or superseded the row since (an answered
        // approval marks it read; a finished turn turns it into chat_complete).
        const row = storage.notificationGet(notification.id)
        return row != null && row.readAt == null && row.archivedAt == null && row.kind === notification.kind
      })
    }
  } catch (err) {
    console.error('[Inbox] notify failed:', err)
  }
}

/** Where a task's agent session lives, so its notice and its conversation read as one row. */
export interface TaskSessionRef {
  chatId: number | null
  workspaceId: number | null
  agentId: number | null
}

type TaskSessionResolver = (taskId: number) => TaskSessionRef | null
let resolveTaskSession: TaskSessionResolver | null = null

/** Set by the orchestrator, which owns task bindings. Unset (tests, early boot) = no session ids. */
export function setTaskSessionResolver(resolver: TaskSessionResolver | null): void {
  resolveTaskSession = resolver
}

function taskSession(taskId: number): TaskSessionRef | null {
  try {
    return resolveTaskSession?.(taskId) ?? null
  } catch {
    return null
  }
}

/**
 * When each task last had a status notice written. A turn that moved the task
 * already said what it did ("Ready for review"); its turn-end notice must not
 * overwrite that row with a vaguer one.
 */
const taskStatusNotifiedAt = new Map<number, number>()

/**
 * Emit an inbox notification for a task status transition, if the new status is
 * one the user cares about (agent blocked → needs_input, agent finished → in_review, or a task closing out →
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
    case 'needs_input':
      kind = 'task_needs_input'
      severity = 'action'
      verb = 'Needs your input'
      break
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
  taskStatusNotifiedAt.set(task.id, Date.now())
  const session = taskSession(task.id)
  notify(storage, {
    kind,
    severity,
    sourceKey: `task:${task.id}`,
    projectId: task.projectId,
    taskId: task.id,
    chatId: session?.chatId ?? null,
    workspaceId: session?.workspaceId ?? null,
    agentId: session?.agentId ?? null,
    title: task.title,
    body: `${verb} · #${task.number}`,
  })
}

/**
 * A task's agent finished a turn. Refreshes the task's own row so every round
 * of work — including one a comment woke — is announced once, on the task,
 * instead of by whichever chat signal happened to be watching.
 *
 * Skipped when the turn already moved the task (its status notice says more),
 * when the task is waiting on the user or closed (those have their own notice),
 * and for OperonSpec work (the spec announces its own gates). Never pushes: the
 * phone hears about status changes, not every reply.
 */
export function notifyTaskTurnFinished(
  storage: NotificationStorageAdapter,
  task: { id: number; projectId: number; number: number; title: string; status: TaskStatus },
  session: TaskSessionRef,
  turnStartedAt: number,
): void {
  if ((taskStatusNotifiedAt.get(task.id) ?? 0) >= turnStartedAt) return
  if (task.status !== 'in_review' && task.status !== 'in_progress' && task.status !== 'todo') return
  notify(storage, {
    kind: 'task_reply',
    // Still in review: the ball is in the user's court, as it was before the turn.
    severity: task.status === 'in_review' ? 'action' : 'info',
    sourceKey: `task:${task.id}`,
    projectId: task.projectId,
    taskId: task.id,
    chatId: session.chatId,
    workspaceId: session.workspaceId,
    agentId: session.agentId,
    title: task.title,
    body: `Agent replied · #${task.number}`,
    push: false,
  })
}

/**
 * Read or dismissed rows are kept this long, then deleted. No screen lists them
 * any more (the Focus view and the phone inbox show unread rows only), so this
 * is just a short buffer, not a history.
 */
export const NOTIFICATION_RETENTION_MS = 7 * 24 * 60 * 60_000
const PRUNE_INTERVAL_MS = 24 * 60 * 60_000

/**
 * Keep the inbox table from growing forever: every row is coalesced per source,
 * but read and archived rows were never removed. Runs once now and then daily.
 */
export function startNotificationPruning(storage: NotificationStorageAdapter): () => void {
  const prune = () => {
    try {
      const removed = storage.notificationPrune(Date.now() - NOTIFICATION_RETENTION_MS)
      if (removed > 0) console.log(`[Inbox] pruned ${removed} old notifications`)
    } catch (err) {
      console.error('[Inbox] prune failed:', err)
    }
  }
  prune()
  const timer = setInterval(prune, PRUNE_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** Broadcast a fresh unread-counts snapshot (drives the bell badge). */
export function emitCounts(storage: NotificationStorageAdapter): void {
  try {
    emitInboxEvent({ type: 'counts', ...storage.notificationUnreadCounts() })
  } catch (err) {
    console.error('[Inbox] emitCounts failed:', err)
  }
}
