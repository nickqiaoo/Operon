// User-facing notification inbox — a cross-project "attention center".
// Collects completion / needs-you events from workspace chats and dispatched
// tasks. Distinct from the agent-to-agent inbox (routes/team-inbox-mcp.ts).

export type NotificationKind =
  | 'chat_complete'
  | 'chat_needs_input'
  | 'task_in_review'
  | 'task_done'
  | 'task_failed'
  | 'sdd_gate'
  | 'cron_done'

/** 'action' = needs you (blocking). 'info' = done, FYI. Drives the badge. */
export type NotificationSeverity = 'action' | 'info'

export interface Notification {
  id: number
  kind: NotificationKind
  severity: NotificationSeverity
  /** Deep-link target — filled per source type; the rest stay null. */
  projectId: number | null
  workspaceId: number | null
  chatId: number | null
  taskId: number | null
  agentId: number | null
  title: string
  body: string | null
  /** Coalescing key: one live row per source (e.g. 'chat:42' | 'task:17'). */
  sourceKey: string
  readAt: number | null
  archivedAt: number | null
  createdAt: number
  updatedAt: number
}

/** Input to notify() — upserts by sourceKey and re-unreads the row. */
export interface NotifyInput {
  kind: NotificationKind
  severity: NotificationSeverity
  sourceKey: string
  title: string
  body?: string | null
  projectId?: number | null
  workspaceId?: number | null
  chatId?: number | null
  taskId?: number | null
  agentId?: number | null
  /**
   * Set false to record/refresh the inbox row without relaying a phone push.
   * For repeat events on a source the user has already been notified about —
   * the row should stay current, but a second buzz says nothing new.
   * Irrelevant for 'info', which never pushes at all.
   */
  push?: boolean
}

export interface ListNotificationsQuery {
  /** Filter by severity; omitted = all. */
  severity?: NotificationSeverity
  /** Only unread rows (read_at IS NULL). */
  unreadOnly?: boolean
  /** Keyset pagination: return rows with id < cursor. */
  cursor?: number
  /** Page size (default 50). */
  limit?: number
}

export interface UnreadCounts {
  /** All unread + visible. */
  total: number
  /** Unread + visible + severity 'action' — the red badge count. */
  action: number
}
