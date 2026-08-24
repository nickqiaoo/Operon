// Mirrors server/src/types/notification.ts. The user notification inbox — a
// cross-project attention feed. Distinct from OS-notification settings
// (src/stores/notification-store.ts).

export type NotificationKind =
  | 'chat_complete'
  | 'chat_needs_input'
  | 'task_in_review'
  | 'task_done'
  | 'task_failed'
  | 'sdd_gate'
  | 'cron_done'

export type NotificationSeverity = 'action' | 'info'

export interface Notification {
  id: number
  kind: NotificationKind
  severity: NotificationSeverity
  projectId: number | null
  workspaceId: number | null
  chatId: number | null
  taskId: number | null
  agentId: number | null
  title: string
  body: string | null
  sourceKey: string
  readAt: number | null
  archivedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface UnreadCounts {
  total: number
  action: number
}

/** SSE payloads pushed on /api/inbox/stream. */
export type InboxEvent =
  | { type: 'notification_upsert'; notification: Notification }
  | { type: 'notification_read'; ids: number[] }
  | { type: 'notification_archive'; ids: number[] }
  | { type: 'counts'; total: number; action: number }
