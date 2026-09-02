import fs from 'fs'
import Database from 'better-sqlite3'
import type {
  ChatHistoryEntry,
  ChatHistoryListItem,
  ChatHistoryPatchInput,
  ChatHistoryPatchResult,
  ChatType,
} from '../types/chat.js'
import type { CronjobExecutionHistoryItem, CronjobRunResult, CronjobSchedule, CronjobTask } from '../types/cronjob.js'
import type {
  AgentBindingStorageAdapter,
  CanvasWorkflowStorageAdapter,
  ChannelStorageAdapter,
  ChatStorageAdapter,
  CheckpointRecord,
  CheckpointStorageAdapter,
  CronjobStorageAdapter,
  IMStorageAdapter,
  ListChatEntriesQuery,
  MemoryMaintenanceStorageAdapter,
  MobilePairingStorageAdapter,
  ProjectStorageAdapter,
  StorageAdapter,
  TaskStorageAdapter,
  NotificationStorageAdapter,
} from './interface.js'
import type {
  AgentBinding,
  AgentInboxMessageRow,
  AgentMessageCursor,
  BindingChannelKind,
  BindingScopeKind,
  BindingStatus,
  CreateAgentInboxMessageInput,
  CursorStreamKind,
  InboxRefKind,
  ListBindingsQuery,
  UpdateAgentBindingInput,
  UpsertAgentBindingInput,
} from '../types/agent-binding.js'
import type {
  CreateMobilePairingInput,
  MobilePairingRow,
  MobilePairingStatus,
} from '../types/mobile.js'
import type {
  ChatExtractionCandidate,
  CreateMemoryMaintenanceRunInput,
  MemoryMaintenanceConfig,
  MemoryMaintenanceRun,
  UpdateMemoryMaintenanceRunInput,
} from '../types/memory-maintenance.js'
import type {
  CreateIMMessageInput,
  CreateIMProviderInput,
  IMInsertResult,
  IMInteractiveChat,
  IMMessageRow,
  IMProviderMode,
  IMProviderRecord,
  IMSenderKind,
  IMSource,
  UpdateIMProviderInput,
  UpsertIMInteractiveChatInput,
} from '../types/im.js'
import type {
  CanvasWorkflow,
  CanvasWorkflowLastRun,
  CanvasWorkflowListItem,
  CanvasWorkflowRun,
  CreateCanvasWorkflowInput,
  NodeResult,
  NodeResultUpdate,
  UpdateCanvasWorkflowInput,
} from '../types/canvas-workflow.js'
import type { Project, Workspace, CreateProjectInput, CreateWorkspaceInput } from '../types/project.js'
import type {
  Agent,
  Channel,
  ChannelMember,
  ChannelMessage,
  CreateAgentInput,
  CreateChannelInput,
  CreateMessageInput,
  MessageSenderType,
  UpdateAgentInput,
} from '../types/channel.js'
import type {
  Task,
  TaskActivity,
  TaskActivityInput,
  TaskActor,
  TaskDetail,
  TaskLabel,
  TaskListItem,
  TaskPriority,
  TaskStatus as ProjectTaskStatus,
  Team,
  CreateTeamInput,
  UpdateTeamInput,
  ListTasksQuery,
  CreateTaskLabelInput,
  CreateTaskInput as CreateProjectTaskInput,
  UpdateTaskInput as UpdateProjectTaskInput,
  TaskArtifact,
  ArtifactKind,
  UpsertArtifactInput,
} from '../types/task.js'
import type {
  Notification,
  NotifyInput,
  ListNotificationsQuery,
  NotificationKind,
  NotificationSeverity,
  UnreadCounts,
} from '../types/notification.js'
import { runMigrations } from './migrate.js'

interface ChatRow {
  id: number
  tp: string
  title: string
  workspace_id: number | null
  model: string | null
  provider_id: string | null
  session_id: string | null
  thinking_level: string | null
  updated_at: number
  metadata: string | null
  revision: number
}

interface ChatListRow {
  id: number
  tp: string
  title: string
  model: string | null
  provider_id: string | null
  session_id: string | null
  thinking_level: string | null
  updated_at: number
  metadata: string | null
}

interface CronjobRow {
  id: number
  name: string
  enabled: number
  task_type: string
  canvas_workflow_id: number | null
  workspace_id: number | null
  provider_id: string
  model_id: string | null
  mode_id: string | null
  thinking_level: string | null
  prompt: string
  schedule_type: string
  schedule_time: string | null
  schedule_days: string | null
  schedule_minutes: number | null
  schedule_end_time: string | null
  created_at: number
  updated_at: number
  last_run_at: number | null
  next_run_at: number | null
  last_result_status: string | null
  last_result_output: string | null
  last_result_error: string | null
  last_result_finished_at: number | null
  last_result_duration_ms: number | null
}

interface CronjobRunRow {
  id: number
  chat_id: number | null
  cronjob_id: number
  timestamp: number
  title: string
  status: string
  provider_id: string | null
  model: string | null
}

interface CheckpointRow {
  message_uid: string
  snapshot_id: string
  end_snapshot_id: string | null
  overlapped: number | null
  created_at: number
}

interface CronjobScheduleSqlValue {
  type: 'daily'
  time: string
  days: string
  intervalMinutes: number | null
  endTime: string | null
}

interface SqliteStorageOptions {
  migrationsDir?: string
}

/** Raw `workflow_events` row shape (see 0038_workflow_event_log). */
interface WorkflowEventDbRow {
  id: number
  run_id: string
  ts: number
  kind: string
  data: string
}

/** Raw `workflow_run_index` row shape — derived, rebuildable from the log. */
interface WorkflowRunIndexDbRow {
  run_id: string
  chat_id: number | null
  name: string
  status: string
  started_at: number
  ended_at: number | null
}

export class SqliteStorage
  implements StorageAdapter, ChatStorageAdapter, CronjobStorageAdapter, CheckpointStorageAdapter, CanvasWorkflowStorageAdapter, ProjectStorageAdapter, ChannelStorageAdapter, TaskStorageAdapter, NotificationStorageAdapter, IMStorageAdapter, AgentBindingStorageAdapter, MemoryMaintenanceStorageAdapter, MobilePairingStorageAdapter {
  private db: Database.Database

  constructor(dbPath: string, options: SqliteStorageOptions = {}) {
    fs.mkdirSync(dbPath.replace(/\/[^/]+$/, ''), { recursive: true })

    this.db = new Database(dbPath)

    // Performance pragmas
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')

    runMigrations(this.db, {
      migrationsDir: options.migrationsDir,
    })

    this.discardStaleSideChats()

    // The db holds provider API keys and IM bot tokens; keep it out of reach
    // of other OS users. After migrations so the WAL/SHM side files (created
    // on first write, with the process umask — typically 644) exist too.
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        fs.chmodSync(p, 0o600)
      } catch {
        // side file not created yet — the next startup tightens it
      }
    }
  }

  /**
   * Drop every side chat left over from a previous run.
   *
   * A side chat is a branch of another conversation held in the agent's memory:
   * its forked thread is ephemeral (never written to disk) and the tab that owns
   * it is not persisted either. So a side chat cannot survive a restart by
   * construction, and any row still here at startup is unreachable — no listing
   * shows side chats, and nothing else can navigate to one. Clearing them keeps
   * the rows a user abandons by quitting from accumulating forever.
   */
  private discardStaleSideChats(): void {
    const result = this.db
      .prepare("DELETE FROM chats WHERE tp = 'side'")
      .run()
    if (result.changes > 0) {
      // Messages are keyed by chat_id with no foreign keys, so they go separately.
      this.db
        .prepare(
          "DELETE FROM chat_messages WHERE chat_id NOT IN (SELECT id FROM chats)",
        )
        .run()
    }
  }

  /** Expose the underlying database for direct queries (e.g. embedding system). */
  getDatabase(): Database.Database {
    return this.db
  }

  // ---- KV Storage ----

  get<T = unknown>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    if (!row) return undefined
    try {
      return JSON.parse(row.value) as T
    } catch {
      return undefined
    }
  }

  set<T = unknown>(key: string, value: T): void {
    const json = JSON.stringify(value)
    this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, json)
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key)
  }

  getAll<T = unknown>(): T | undefined {
    const rows = this.db.prepare('SELECT key, value FROM kv').all() as Array<{
      key: string
      value: string
    }>
    if (rows.length === 0) return undefined
    const result: Record<string, unknown> = {}
    for (const row of rows) {
      try {
        result[row.key] = JSON.parse(row.value)
      } catch {
        result[row.key] = row.value
      }
    }
    return result as T
  }

  setAll<T = unknown>(data: T): void {
    const record = data as Record<string, unknown>
    const upsert = this.db.prepare(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    const run = this.db.transaction((entries: Array<[string, unknown]>) => {
      for (const [key, value] of entries) {
        upsert.run(key, JSON.stringify(value))
      }
    })
    run(Object.entries(record))
  }

  keys(prefix?: string): string[] {
    if (!prefix) {
      const rows = this.db.prepare('SELECT key FROM kv').all() as Array<{ key: string }>
      return rows.map((r) => r.key)
    }
    const rows = this.db
      .prepare('SELECT key FROM kv WHERE key LIKE ? ESCAPE \'\\\'')
      .all(escapeLike(prefix) + '%') as Array<{ key: string }>
    return rows.map((r) => r.key)
  }

  /** Run multiple operations in a single transaction */
  transaction<R>(fn: () => R): R {
    return this.db.transaction(fn)()
  }

  // ---- Chat ----

  getChatEntry(chatId: number): ChatHistoryEntry | undefined {
    const row = this.db
      .prepare('SELECT id, tp, title, workspace_id, model, provider_id, session_id, thinking_level, updated_at, metadata, revision FROM chats WHERE id = ?')
      .get(chatId) as ChatRow | undefined

    if (!row) return undefined

    const messageRows = this.db
      .prepare('SELECT payload FROM chat_messages WHERE chat_id = ? ORDER BY message_index ASC')
      .all(chatId) as Array<{ payload: string }>

    const messages = messageRows.map((message) => parseJsonOrRaw(message.payload))

    return {
      messages,
      tp: row.tp as ChatType,
      title: row.title,
      workspaceId: row.workspace_id ?? undefined,
      model: row.model ?? undefined,
      providerId: row.provider_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      thinkingLevel: row.thinking_level ?? undefined,
      updatedAt: row.updated_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      revision: row.revision,
    }
  }

  getChatMessages(chatId: number, opts?: { before?: number; limit?: number }): { messages: unknown[]; total: number; hasMore: boolean; nextCursor?: number } | undefined {
    const exists = this.db.prepare('SELECT 1 FROM chats WHERE id = ?').get(chatId)
    if (!exists) return undefined

    const totalRow = this.db
      .prepare('SELECT COUNT(*) as count FROM chat_messages WHERE chat_id = ?')
      .get(chatId) as { count: number }
    const total = totalRow.count

    const limit = opts?.limit ?? 50
    const fetchLimit = limit + 1
    let messageRows: Array<{ message_index: number; payload: string }>
    if (opts?.before !== undefined) {
      messageRows = this.db
        .prepare('SELECT message_index, payload FROM chat_messages WHERE chat_id = ? AND message_index < ? ORDER BY message_index DESC LIMIT ?')
        .all(chatId, opts.before, fetchLimit) as Array<{ message_index: number; payload: string }>
    } else {
      messageRows = this.db
        .prepare('SELECT message_index, payload FROM chat_messages WHERE chat_id = ? ORDER BY message_index DESC LIMIT ?')
        .all(chatId, fetchLimit) as Array<{ message_index: number; payload: string }>
    }

    const hasMore = messageRows.length > limit
    if (hasMore) messageRows = messageRows.slice(0, limit)
    messageRows.reverse()
    // nextCursor is the message_index of the first returned row (to pass as `before` for next page)
    const nextCursor = hasMore && messageRows.length > 0 ? messageRows[0].message_index : undefined

    // Dedup by message id: a client/server desync (e.g. a bad `replaceFrom`
    // during rewind/steer) can store the same message at two message_index
    // rows. Keep the first (lowest-index) occurrence so the API never returns
    // duplicate ids — which would break React keys on the client.
    const seenIds = new Set<string>()
    const messages: unknown[] = []
    for (const r of messageRows) {
      const msg = parseJsonOrRaw(r.payload)
      const id = (msg as { id?: string })?.id
      if (id) {
        if (seenIds.has(id)) continue
        seenIds.add(id)
      }
      messages.push(msg)
    }
    return { messages, total, hasMore, nextCursor }
  }

  getChatMeta(chatId: number): import('../types/chat.js').ChatMeta | undefined {
    const row = this.db
      .prepare('SELECT id, tp, title, workspace_id, model, provider_id, session_id, thinking_level, updated_at, metadata, revision FROM chats WHERE id = ?')
      .get(chatId) as ChatRow | undefined
    if (!row) return undefined

    return {
      revision: row.revision,
      tp: row.tp as import('../types/chat.js').ChatType,
      title: row.title,
      workspaceId: row.workspace_id ?? undefined,
      model: row.model ?? undefined,
      providerId: row.provider_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      thinkingLevel: row.thinking_level ?? undefined,
      updatedAt: row.updated_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }
  }

  patchChatEntry(chatId: number | null, input: ChatHistoryPatchInput): ChatHistoryPatchResult {
    const selectChat = this.db.prepare(
      'SELECT id, tp, title, workspace_id, model, provider_id, session_id, thinking_level, updated_at, metadata, revision FROM chats WHERE id = ?'
    )
    const selectMessageCount = this.db.prepare(
      'SELECT COUNT(*) as count FROM chat_messages WHERE chat_id = ?'
    )
    const insertChat = this.db.prepare(`
      INSERT INTO chats (tp, title, workspace_id, model, provider_id, session_id, thinking_level, updated_at, metadata, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const updateChat = this.db.prepare(`
      UPDATE chats
      SET tp = ?, title = ?, workspace_id = ?, model = ?, provider_id = ?, session_id = ?, thinking_level = ?, updated_at = ?, metadata = ?, revision = ?
      WHERE id = ?
    `)
    const deleteMessagesFrom = this.db.prepare(
      'DELETE FROM chat_messages WHERE chat_id = ? AND message_index >= ?'
    )
    const insertMessage = this.db.prepare(
      'INSERT INTO chat_messages (chat_id, uid, message_index, payload) VALUES (?, ?, ?, ?)'
    )

    const run = this.db.transaction((patch: { id: number | null; value: ChatHistoryPatchInput }): ChatHistoryPatchResult => {
      if (patch.value.replaceFrom < -1) {
        return { success: false, conflict: true, revision: 0 }
      }

      // Create new chat
      if (patch.id === null) {
        if (patch.value.baseRevision !== 0) {
          return { success: false, conflict: true, revision: 0 }
        }

        const title = patch.value.title?.trim() || 'Chat'
        const nextRevision = 1
        const tp = patch.value.tp || 'chat'
        const result = insertChat.run(
          tp,
          title,
          patch.value.workspaceId ?? null,
          patch.value.model ?? null,
          patch.value.providerId ?? null,
          patch.value.sessionId ?? null,
          patch.value.thinkingLevel ?? null,
          patch.value.updatedAt,
          patch.value.metadata ? JSON.stringify(patch.value.metadata) : null,
          nextRevision
        )

        const newChatId = Number(result.lastInsertRowid)

        for (const [offset, message] of patch.value.tailMessages.entries()) {
          const uid = (message as { id?: string })?.id ?? ''
          insertMessage.run(newChatId, uid, patch.value.replaceFrom + offset, JSON.stringify(message))
        }

        return { success: true, chatId: newChatId, revision: nextRevision }
      }

      // Update existing chat
      const existingChat = selectChat.get(patch.id) as ChatRow | undefined
      if (!existingChat) {
        return { success: false, conflict: true, revision: 0 }
      }

      const currentRevision = existingChat.revision
      if (currentRevision !== patch.value.baseRevision) {
        return { success: false, conflict: true, revision: currentRevision }
      }

      const messageCountRow = selectMessageCount.get(patch.id) as { count: number }

      // replaceFrom = -1 means "append to end"
      const replaceFrom = patch.value.replaceFrom === -1
        ? messageCountRow.count
        : patch.value.replaceFrom

      if (replaceFrom > messageCountRow.count) {
        return { success: false, conflict: true, revision: currentRevision }
      }

      const nextRevision = currentRevision + 1
      const title = (patch.value.title ?? existingChat.title).trim() || 'Chat'
      const tp = patch.value.tp ?? existingChat.tp
      const metadataJson = patch.value.metadata
        ? JSON.stringify(patch.value.metadata)
        : existingChat.metadata

      updateChat.run(
        tp,
        title,
        patch.value.workspaceId ?? existingChat.workspace_id,
        patch.value.model ?? existingChat.model,
        patch.value.providerId ?? existingChat.provider_id,
        patch.value.sessionId ?? existingChat.session_id,
        patch.value.thinkingLevel ?? existingChat.thinking_level,
        patch.value.updatedAt,
        metadataJson,
        nextRevision,
        patch.id
      )

      deleteMessagesFrom.run(patch.id, replaceFrom)
      for (const [offset, message] of patch.value.tailMessages.entries()) {
        const uid = (message as { id?: string })?.id ?? ''
        insertMessage.run(patch.id, uid, replaceFrom + offset, JSON.stringify(message))
      }

      return { success: true, chatId: patch.id, revision: nextRevision }
    })

    return run({ id: chatId, value: input })
  }

  // `updated_at` means "when this conversation last gained a message" — the
  // chat list sorts on it and the client times prompt-cache expiry from it.
  // Session-id capture and metadata bookkeeping (mobile stream status, mode
  // switches) are neither, so they deliberately leave the column alone.
  updateChatSessionId(chatId: number, sessionId: string): void {
    this.db.prepare('UPDATE chats SET session_id = ? WHERE id = ?')
      .run(sessionId, chatId)
  }

  findChatBySessionId(sessionId: string): (import('../types/chat.js').ChatMeta & { id: number }) | undefined {
    const row = this.db
      .prepare('SELECT id FROM chats WHERE session_id = ? ORDER BY id DESC LIMIT 1')
      .get(sessionId) as { id: number } | undefined
    if (!row) return undefined
    const meta = this.getChatMeta(row.id)
    return meta ? { ...meta, id: row.id } : undefined
  }

  updateChatMetadata(chatId: number, metadata: import('../types/chat.js').ChatMetadata): void {
    this.db.prepare('UPDATE chats SET metadata = ? WHERE id = ?')
      .run(JSON.stringify(metadata), chatId)
  }

  // --- Workflow event log (0038) ---------------------------------------------
  // One append-only table plus a derived index. There is no snapshot column and
  // no second table holding the same facts: everything the panel shows is folded
  // from these rows (services/workflow/fold.ts).

  appendWorkflowEvents(rows: import('./interface.js').WorkflowEventInput[]): number {
    if (rows.length === 0) return this.lastWorkflowEventId()
    const insert = this.db.prepare(
      'INSERT INTO workflow_events (run_id, ts, kind, data) VALUES (?, ?, ?, ?)',
    )
    // One transaction: a batch of chunks (or a settle plus its trailing events)
    // must never be half-visible to a reader folding a view.
    const runAll = this.db.transaction((batch: import('./interface.js').WorkflowEventInput[]) => {
      let lastId = 0
      for (const row of batch) {
        lastId = Number(insert.run(row.runId, row.ts, row.kind, row.data).lastInsertRowid)
      }
      return lastId
    })
    return runAll(rows)
  }

  private mapWorkflowEventRow(row: WorkflowEventDbRow): import('./interface.js').WorkflowEventRow {
    return { id: row.id, runId: row.run_id, ts: row.ts, kind: row.kind, data: row.data }
  }

  /** Shared WHERE-builder for the three event reads. */
  private workflowEventFilter(opts?: import('./interface.js').WorkflowEventQuery): {
    sql: string
    params: unknown[]
  } {
    const clauses: string[] = []
    const params: unknown[] = []
    if (opts?.sinceId != null) {
      clauses.push('id > ?')
      params.push(opts.sinceId)
    }
    if (opts?.kinds?.length) {
      clauses.push(`kind IN (${opts.kinds.map(() => '?').join(', ')})`)
      params.push(...opts.kinds)
    }
    if (opts?.excludeKinds?.length) {
      clauses.push(`kind NOT IN (${opts.excludeKinds.map(() => '?').join(', ')})`)
      params.push(...opts.excludeKinds)
    }
    return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params }
  }

  readWorkflowEvents(
    runId: string,
    opts?: import('./interface.js').WorkflowEventQuery,
  ): import('./interface.js').WorkflowEventRow[] {
    const filter = this.workflowEventFilter(opts)
    const rows = this.db
      .prepare(
        `SELECT id, run_id, ts, kind, data FROM workflow_events
         WHERE run_id = ?${filter.sql} ORDER BY id ASC${opts?.limit != null ? ' LIMIT ?' : ''}`,
      )
      .all(runId, ...filter.params, ...(opts?.limit != null ? [opts.limit] : [])) as WorkflowEventDbRow[]
    return rows.map((row) => this.mapWorkflowEventRow(row))
  }

  readWorkflowEventsForRuns(
    runIds: string[],
    opts?: import('./interface.js').WorkflowEventQuery,
  ): import('./interface.js').WorkflowEventRow[] {
    if (runIds.length === 0) return []
    const filter = this.workflowEventFilter(opts)
    const rows = this.db
      .prepare(
        `SELECT id, run_id, ts, kind, data FROM workflow_events
         WHERE run_id IN (${runIds.map(() => '?').join(', ')})${filter.sql} ORDER BY id ASC`,
      )
      .all(...runIds, ...filter.params) as WorkflowEventDbRow[]
    return rows.map((row) => this.mapWorkflowEventRow(row))
  }

  readWorkflowEventsSince(
    sinceId: number,
    opts?: { excludeKinds?: string[]; limit?: number },
  ): import('./interface.js').WorkflowEventRow[] {
    const filter = this.workflowEventFilter({ excludeKinds: opts?.excludeKinds })
    const rows = this.db
      .prepare(
        `SELECT id, run_id, ts, kind, data FROM workflow_events
         WHERE id > ?${filter.sql} ORDER BY id ASC${opts?.limit != null ? ' LIMIT ?' : ''}`,
      )
      .all(sinceId, ...filter.params, ...(opts?.limit != null ? [opts.limit] : [])) as WorkflowEventDbRow[]
    return rows.map((row) => this.mapWorkflowEventRow(row))
  }

  lastWorkflowEventId(): number {
    const row = this.db.prepare('SELECT MAX(id) AS id FROM workflow_events').get() as
      | { id: number | null }
      | undefined
    return row?.id ?? 0
  }

  upsertWorkflowRunIndex(row: import('./interface.js').WorkflowRunIndexRow): void {
    this.db
      .prepare(
        `INSERT INTO workflow_run_index (run_id, chat_id, name, status, started_at, ended_at, sort_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           chat_id = excluded.chat_id,
           name = excluded.name,
           status = excluded.status,
           started_at = excluded.started_at,
           ended_at = excluded.ended_at,
           sort_at = excluded.sort_at`,
      )
      .run(
        row.runId,
        row.chatId,
        row.name,
        row.status,
        row.startedAt,
        row.endedAt,
        row.endedAt ?? row.startedAt,
      )
  }

  private mapWorkflowRunIndexRow(
    row: WorkflowRunIndexDbRow,
  ): import('./interface.js').WorkflowRunIndexRow {
    return {
      runId: row.run_id,
      chatId: row.chat_id,
      name: row.name,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    }
  }

  listWorkflowRunIndex(limit = 50): import('./interface.js').WorkflowRunIndexRow[] {
    const rows = this.db
      .prepare(
        `SELECT run_id, chat_id, name, status, started_at, ended_at
         FROM workflow_run_index ORDER BY sort_at DESC LIMIT ?`,
      )
      .all(limit) as WorkflowRunIndexDbRow[]
    return rows.map((row) => this.mapWorkflowRunIndexRow(row))
  }

  getWorkflowRunIndex(runId: string): import('./interface.js').WorkflowRunIndexRow | undefined {
    const row = this.db
      .prepare(
        `SELECT run_id, chat_id, name, status, started_at, ended_at
         FROM workflow_run_index WHERE run_id = ?`,
      )
      .get(runId) as WorkflowRunIndexDbRow | undefined
    return row ? this.mapWorkflowRunIndexRow(row) : undefined
  }

  listRunningWorkflowRunIds(): string[] {
    const rows = this.db
      .prepare("SELECT run_id FROM workflow_run_index WHERE status = 'running'")
      .all() as { run_id: string }[]
    return rows.map((row) => row.run_id)
  }

  pruneWorkflowRuns(keep: number): number {
    const stale = this.db
      .prepare(
        `SELECT run_id FROM workflow_run_index
         WHERE status != 'running'
           AND run_id NOT IN (SELECT run_id FROM workflow_run_index ORDER BY sort_at DESC LIMIT ?)`,
      )
      .all(Math.max(0, keep)) as { run_id: string }[]
    if (stale.length === 0) return 0
    const dropEvents = this.db.prepare('DELETE FROM workflow_events WHERE run_id = ?')
    const dropIndex = this.db.prepare('DELETE FROM workflow_run_index WHERE run_id = ?')
    const runAll = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        dropEvents.run(id)
        dropIndex.run(id)
      }
    })
    runAll(stale.map((row) => row.run_id))
    return stale.length
  }

  deleteChatEntry(chatId: number): void {
    this.db.prepare('DELETE FROM chat_messages WHERE chat_id = ?').run(chatId)
    this.db.prepare('DELETE FROM chats WHERE id = ?').run(chatId)
  }

  listChatEntries(query?: ListChatEntriesQuery): ChatHistoryListItem[] {
    const whereClauses: string[] = []
    const params: (string | number)[] = []

    if (query?.workspaceId !== undefined) {
      whereClauses.push('workspace_id = ?')
      params.push(query.workspaceId)
    }
    if (query?.tp !== undefined) {
      whereClauses.push('tp = ?')
      params.push(query.tp)
    } else {
      // Side chats are throwaway branches of another conversation and never
      // belong in a history list; the tab that owns one is the only way back to
      // it. An explicit `tp` filter still reaches them (the side chat tab reads
      // its own row by id, not through here).
      whereClauses.push("tp != 'side'")
    }

    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''

    // Paging is opt-in: without `limit` this still returns the whole workspace,
    // which callers like the canvas picker (tp='canvas', a handful of rows) rely
    // on. The chat history UI passes a limit so a workspace with hundreds of
    // conversations doesn't ship them all in one response.
    let pagination = ''
    if (query?.limit !== undefined) {
      pagination = 'LIMIT ?'
      params.push(query.limit)
      if (query.offset) {
        pagination += ' OFFSET ?'
        params.push(query.offset)
      }
    }

    const sql = `
      SELECT id, tp, title, model, provider_id, session_id, thinking_level, updated_at, metadata
      FROM chats
      ${where}
      ORDER BY updated_at DESC
      ${pagination}
    `
    const rows = this.db.prepare(sql).all(...params) as ChatListRow[]

    return rows.map((row) => ({
      id: row.id,
      tp: row.tp as ChatType,
      title: row.title,
      updatedAt: row.updated_at,
      model: row.model ?? undefined,
      providerId: row.provider_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      thinkingLevel: row.thinking_level ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }))
  }

  // ---- Cronjob ----

  listCronjobs(): CronjobTask[] {
    const rows = this.db
      .prepare(`
        SELECT
          id, name, enabled, task_type, canvas_workflow_id,
          workspace_id,
          provider_id, model_id, mode_id, thinking_level,
          prompt, schedule_type, schedule_time, schedule_days, schedule_minutes, schedule_end_time,
          created_at, updated_at, last_run_at, next_run_at,
          last_result_status, last_result_output, last_result_error,
          last_result_finished_at, last_result_duration_ms
        FROM cronjobs
        ORDER BY updated_at DESC
      `)
      .all() as CronjobRow[]
    return rows.map((row) => rowToCronjobTask(row))
  }

  getCronjobById(id: number): CronjobTask | undefined {
    const row = this.db
      .prepare(`
        SELECT
          id, name, enabled, task_type, canvas_workflow_id,
          workspace_id,
          provider_id, model_id, mode_id, thinking_level,
          prompt, schedule_type, schedule_time, schedule_days, schedule_minutes, schedule_end_time,
          created_at, updated_at, last_run_at, next_run_at,
          last_result_status, last_result_output, last_result_error,
          last_result_finished_at, last_result_duration_ms
        FROM cronjobs
        WHERE id = ?
      `)
      .get(id) as CronjobRow | undefined
    return row ? rowToCronjobTask(row) : undefined
  }

  upsertCronjob(job: CronjobTask): void {
    const schedule = toCronjobScheduleSql(job.schedule)
    const lastResult = job.lastResult

    if (job.id <= 0) {
      const result = this.db
        .prepare(`
          INSERT INTO cronjobs (
            name, enabled, task_type, canvas_workflow_id,
            workspace_id,
            provider_id, model_id, mode_id, thinking_level,
            prompt, schedule_type, schedule_time, schedule_days, schedule_minutes, schedule_end_time,
            created_at, updated_at, last_run_at, next_run_at,
            last_result_status, last_result_output, last_result_error,
            last_result_finished_at, last_result_duration_ms
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          job.name,
          job.enabled ? 1 : 0,
          job.taskType,
          job.canvasWorkflowId ?? null,
          job.workspaceId ?? null,
          job.providerId,
          job.modelId ?? null,
          job.modeId ?? null,
          job.thinkingLevel ?? null,
          job.prompt,
          schedule.type,
          schedule.time,
          schedule.days,
          schedule.intervalMinutes,
          schedule.endTime,
          job.createdAt,
          job.updatedAt,
          job.lastRunAt ?? null,
          job.nextRunAt ?? null,
          lastResult?.status ?? null,
          lastResult?.output ?? null,
          lastResult?.error ?? null,
          lastResult?.finishedAt ?? null,
          lastResult?.durationMs ?? null
        )
      job.id = Number(result.lastInsertRowid)
      return
    }

    this.db
      .prepare(`
        INSERT INTO cronjobs (
          id, name, enabled, task_type, canvas_workflow_id,
          workspace_id,
          provider_id, model_id, mode_id, thinking_level,
          prompt, schedule_type, schedule_time, schedule_days, schedule_minutes, schedule_end_time,
          created_at, updated_at, last_run_at, next_run_at,
          last_result_status, last_result_output, last_result_error,
          last_result_finished_at, last_result_duration_ms
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          enabled = excluded.enabled,
          task_type = excluded.task_type,
          canvas_workflow_id = excluded.canvas_workflow_id,
          workspace_id = excluded.workspace_id,
          provider_id = excluded.provider_id,
          model_id = excluded.model_id,
          mode_id = excluded.mode_id,
          thinking_level = excluded.thinking_level,
          prompt = excluded.prompt,
          schedule_type = excluded.schedule_type,
          schedule_time = excluded.schedule_time,
          schedule_days = excluded.schedule_days,
          schedule_minutes = excluded.schedule_minutes,
          schedule_end_time = excluded.schedule_end_time,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          last_run_at = excluded.last_run_at,
          next_run_at = excluded.next_run_at,
          last_result_status = excluded.last_result_status,
          last_result_output = excluded.last_result_output,
          last_result_error = excluded.last_result_error,
          last_result_finished_at = excluded.last_result_finished_at,
          last_result_duration_ms = excluded.last_result_duration_ms
      `)
      .run(
        job.id,
        job.name,
        job.enabled ? 1 : 0,
        job.taskType,
        job.canvasWorkflowId ?? null,
        job.workspaceId ?? null,
        job.providerId,
        job.modelId ?? null,
        job.modeId ?? null,
        job.thinkingLevel ?? null,
        job.prompt,
        schedule.type,
        schedule.time,
        schedule.days,
        schedule.intervalMinutes,
        schedule.endTime,
        job.createdAt,
        job.updatedAt,
        job.lastRunAt ?? null,
        job.nextRunAt ?? null,
        lastResult?.status ?? null,
        lastResult?.output ?? null,
        lastResult?.error ?? null,
        lastResult?.finishedAt ?? null,
        lastResult?.durationMs ?? null
      )
  }

  deleteCronjobById(id: number): boolean {
    const result = this.db.prepare('DELETE FROM cronjobs WHERE id = ?').run(id)
    return result.changes > 0
  }

  listCronjobRuns(jobId: number): CronjobExecutionHistoryItem[] {
    const rows = this.db
      .prepare(`
        SELECT id, chat_id, cronjob_id, timestamp, title, status, provider_id, model
        FROM cronjob_runs
        WHERE cronjob_id = ?
        ORDER BY timestamp DESC
      `)
      .all(jobId) as CronjobRunRow[]

    return rows.map((row) => ({
      chatId: row.chat_id ?? undefined,
      jobId: row.cronjob_id,
      timestamp: row.timestamp,
      title: row.title,
      status: toCronjobHistoryStatus(row.status),
      providerId: row.provider_id ?? undefined,
      model: row.model ?? undefined,
    }))
  }

  addCronjobRun(entry: CronjobExecutionHistoryItem): void {
    this.db
      .prepare(`
        INSERT INTO cronjob_runs (chat_id, cronjob_id, timestamp, title, status, provider_id, model)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          cronjob_id = excluded.cronjob_id,
          timestamp = excluded.timestamp,
          title = excluded.title,
          status = excluded.status,
          provider_id = excluded.provider_id,
          model = excluded.model
      `)
      .run(
        entry.chatId ?? null,
        entry.jobId,
        entry.timestamp,
        entry.title,
        entry.status,
        entry.providerId ?? null,
        entry.model ?? null
      )
  }

  // ---- Memory Maintenance ----

  getMemoryMaintenanceConfig(): MemoryMaintenanceConfig {
    const row = this.db
      .prepare(
        'SELECT enabled, schedule_time, provider_id, model_id, layer1_enabled, max_sessions_per_run, updated_at FROM memory_maintenance_config WHERE id = 1'
      )
      .get() as
      | {
        enabled: number
        schedule_time: string
        provider_id: string | null
        model_id: string | null
        layer1_enabled: number
        max_sessions_per_run: number
        updated_at: number
      }
      | undefined

    if (!row) {
      const now = Date.now()
      this.db
        .prepare('INSERT INTO memory_maintenance_config (id, updated_at) VALUES (1, ?)')
        .run(now)
      return {
        enabled: true,
        scheduleTime: '04:00',
        layer1Enabled: true,
        maxSessionsPerRun: 50,
        updatedAt: now,
      }
    }

    return {
      enabled: row.enabled === 1,
      scheduleTime: row.schedule_time,
      providerId: row.provider_id ?? undefined,
      modelId: row.model_id ?? undefined,
      layer1Enabled: row.layer1_enabled === 1,
      maxSessionsPerRun: row.max_sessions_per_run,
      updatedAt: row.updated_at,
    }
  }

  updateMemoryMaintenanceConfig(updates: Partial<Omit<MemoryMaintenanceConfig, 'updatedAt'>>): MemoryMaintenanceConfig {
    const current = this.getMemoryMaintenanceConfig()
    const merged = { ...current, ...updates }
    const now = Date.now()
    this.db
      .prepare(
        `UPDATE memory_maintenance_config SET
          enabled = ?, schedule_time = ?, provider_id = ?, model_id = ?,
          layer1_enabled = ?, max_sessions_per_run = ?, updated_at = ?
        WHERE id = 1`
      )
      .run(
        merged.enabled ? 1 : 0,
        merged.scheduleTime,
        merged.providerId ?? null,
        merged.modelId ?? null,
        merged.layer1Enabled ? 1 : 0,
        merged.maxSessionsPerRun,
        now
      )
    return { ...merged, updatedAt: now }
  }

  listMemoryMaintenanceCandidates(opts: { olderThanMs: number; newerThanMs?: number; limit: number }): ChatExtractionCandidate[] {
    const now = Date.now()
    const upperCutoff = now - opts.olderThanMs
    const lowerCutoff = opts.newerThanMs != null ? now - opts.newerThanMs : null

    const clauses = ['c.updated_at <= ?']
    const params: unknown[] = [upperCutoff]
    if (lowerCutoff != null) {
      clauses.push('c.updated_at >= ?')
      params.push(lowerCutoff)
    }
    clauses.push(
      `EXISTS (
        SELECT 1 FROM chat_messages m
        WHERE m.chat_id = c.id
          AND (c.last_extracted_message_index IS NULL OR m.message_index > c.last_extracted_message_index)
      )`
    )
    params.push(opts.limit)

    const rows = this.db
      .prepare(
        `SELECT c.id, c.title, c.provider_id, c.updated_at, c.last_extracted_message_index,
                (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id = c.id) AS total_messages,
                (SELECT MAX(m.message_index) FROM chat_messages m WHERE m.chat_id = c.id) AS max_index
         FROM chats c
         WHERE ${clauses.join(' AND ')}
         ORDER BY c.updated_at DESC
         LIMIT ?`
      )
      .all(...params) as Array<{
        id: number
        title: string
        provider_id: string | null
        updated_at: number
        last_extracted_message_index: number | null
        total_messages: number
        max_index: number | null
      }>

    return rows.map((row) => ({
      chatId: row.id,
      title: row.title,
      providerId: row.provider_id ?? undefined,
      updatedAt: row.updated_at,
      totalMessages: row.total_messages,
      lastExtractedMessageIndex: row.last_extracted_message_index,
    }))
  }

  setChatLastExtractedMessageIndex(chatId: number, messageIndex: number): void {
    this.db
      .prepare('UPDATE chats SET last_extracted_message_index = ? WHERE id = ?')
      .run(messageIndex, chatId)
  }

  getChatMessagesWithIndex(chatId: number, opts: { afterIndex: number | null; limit?: number }): import('./interface.js').ChatMessageRow[] {
    const limit = opts.limit ?? 2000
    const afterIndex = opts.afterIndex ?? -1
    const rows = this.db
      .prepare(
        'SELECT message_index, payload FROM chat_messages WHERE chat_id = ? AND message_index > ? ORDER BY message_index ASC LIMIT ?'
      )
      .all(chatId, afterIndex, limit) as Array<{ message_index: number; payload: string }>

    return rows.map((row) => ({
      messageIndex: row.message_index,
      payload: parseJsonOrRaw(row.payload),
    }))
  }

  createMemoryMaintenanceRun(input: CreateMemoryMaintenanceRunInput): MemoryMaintenanceRun {
    const result = this.db
      .prepare(
        `INSERT INTO memory_maintenance_runs
          (started_at, layer, provider_id, model_id, status, trigger)
         VALUES (?, ?, ?, ?, 'running', ?)`
      )
      .run(input.startedAt, input.layer, input.providerId ?? null, input.modelId ?? null, input.trigger)

    return {
      id: Number(result.lastInsertRowid),
      startedAt: input.startedAt,
      layer: input.layer,
      providerId: input.providerId,
      modelId: input.modelId,
      sessionsProcessed: 0,
      chunksProcessed: 0,
      memoriesWritten: 0,
      memoriesMerged: 0,
      tokensInput: 0,
      tokensOutput: 0,
      status: 'running',
      trigger: input.trigger,
    }
  }

  updateMemoryMaintenanceRun(id: number, updates: UpdateMemoryMaintenanceRunInput): void {
    const fields: string[] = []
    const values: unknown[] = []

    const map: Array<[keyof UpdateMemoryMaintenanceRunInput, string]> = [
      ['finishedAt', 'finished_at'],
      ['sessionsProcessed', 'sessions_processed'],
      ['chunksProcessed', 'chunks_processed'],
      ['memoriesWritten', 'memories_written'],
      ['memoriesMerged', 'memories_merged'],
      ['tokensInput', 'tokens_input'],
      ['tokensOutput', 'tokens_output'],
      ['status', 'status'],
      ['error', 'error'],
    ]

    for (const [key, column] of map) {
      if (updates[key] !== undefined) {
        fields.push(`${column} = ?`)
        values.push(updates[key])
      }
    }

    if (fields.length === 0) return
    values.push(id)
    this.db.prepare(`UPDATE memory_maintenance_runs SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }

  listMemoryMaintenanceRuns(limit = 20): MemoryMaintenanceRun[] {
    const rows = this.db
      .prepare(
        `SELECT id, started_at, finished_at, layer, provider_id, model_id,
                sessions_processed, chunks_processed, memories_written, memories_merged,
                tokens_input, tokens_output, status, trigger, error
         FROM memory_maintenance_runs
         ORDER BY started_at DESC
         LIMIT ?`
      )
      .all(limit) as Array<{
        id: number
        started_at: number
        finished_at: number | null
        layer: string
        provider_id: string | null
        model_id: string | null
        sessions_processed: number
        chunks_processed: number
        memories_written: number
        memories_merged: number
        tokens_input: number
        tokens_output: number
        status: string
        trigger: string
        error: string | null
      }>

    return rows.map((row) => ({
      id: row.id,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      layer: row.layer as MemoryMaintenanceRun['layer'],
      providerId: row.provider_id ?? undefined,
      modelId: row.model_id ?? undefined,
      sessionsProcessed: row.sessions_processed,
      chunksProcessed: row.chunks_processed,
      memoriesWritten: row.memories_written,
      memoriesMerged: row.memories_merged,
      tokensInput: row.tokens_input,
      tokensOutput: row.tokens_output,
      status: row.status as MemoryMaintenanceRun['status'],
      trigger: row.trigger as MemoryMaintenanceRun['trigger'],
      error: row.error ?? undefined,
    }))
  }

  // ---- Checkpoint ----

  saveCheckpoint(chatId: number, messageUid: string, entry: CheckpointRecord): void {
    // Re-saving a checkpoint means the turn is (re)starting, so any previously
    // recorded end snapshot and overlap verdict no longer describe it — write
    // them back as given.
    this.db
      .prepare(`
        INSERT INTO checkpoints (chat_id, message_uid, snapshot_id, end_snapshot_id, overlapped, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id, message_uid) DO UPDATE SET
          snapshot_id = excluded.snapshot_id,
          end_snapshot_id = excluded.end_snapshot_id,
          overlapped = excluded.overlapped,
          created_at = excluded.created_at
      `)
      .run(
        chatId,
        messageUid,
        entry.snapshotId,
        entry.endSnapshotId ?? null,
        entry.overlapped === undefined ? null : entry.overlapped ? 1 : 0,
        entry.createdAt,
      )
  }

  setCheckpointEnd(chatId: number, messageUid: string, endSnapshotId: string, overlapped?: boolean): void {
    this.db
      .prepare('UPDATE checkpoints SET end_snapshot_id = ?, overlapped = ? WHERE chat_id = ? AND message_uid = ?')
      .run(endSnapshotId, overlapped === undefined ? null : overlapped ? 1 : 0, chatId, messageUid)
  }

  getCheckpoint(chatId: number, messageUid: string): CheckpointRecord | undefined {
    const row = this.db
      .prepare('SELECT snapshot_id, end_snapshot_id, overlapped, created_at FROM checkpoints WHERE chat_id = ? AND message_uid = ?')
      .get(chatId, messageUid) as Omit<CheckpointRow, 'message_uid'> | undefined
    if (!row) return undefined
    return {
      snapshotId: row.snapshot_id,
      endSnapshotId: row.end_snapshot_id ?? undefined,
      overlapped: row.overlapped === null ? undefined : row.overlapped === 1,
      createdAt: row.created_at,
    }
  }

  listCheckpoints(chatId: number): Record<string, CheckpointRecord> {
    const rows = this.db
      .prepare('SELECT message_uid, snapshot_id, end_snapshot_id, overlapped, created_at FROM checkpoints WHERE chat_id = ? ORDER BY created_at DESC')
      .all(chatId) as CheckpointRow[]
    const result: Record<string, CheckpointRecord> = {}
    for (const row of rows) {
      result[row.message_uid] = {
        snapshotId: row.snapshot_id,
        endSnapshotId: row.end_snapshot_id ?? undefined,
        overlapped: row.overlapped === null ? undefined : row.overlapped === 1,
        createdAt: row.created_at,
      }
    }
    return result
  }

  removeCheckpoints(chatId: number): void {
    this.db.prepare('DELETE FROM checkpoints WHERE chat_id = ?').run(chatId)
  }

  pruneCheckpoints(chatId: number, keep: number): string[] {
    // Rows ranked beyond the `keep` most-recent ones are evicted.
    const evicted = this.db
      .prepare('SELECT message_uid FROM checkpoints WHERE chat_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?')
      .all(chatId, keep) as Array<{ message_uid: string }>
    if (evicted.length === 0) return []

    const uids = evicted.map((r) => r.message_uid)
    const del = this.db.prepare('DELETE FROM checkpoints WHERE chat_id = ? AND message_uid = ?')
    this.db.transaction((ids: string[]) => {
      for (const id of ids) del.run(chatId, id)
    })(uids)
    return uids
  }

  // ---- Canvas Workflow ----

  createCanvasWorkflow(input: CreateCanvasWorkflowInput): CanvasWorkflow {
    const now = Date.now()
    const result = this.db.prepare(`
      INSERT INTO canvas_workflows (name, description, workspace_id, nodes, edges, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.name, input.description ?? null, input.workspaceId ?? null, JSON.stringify(input.nodes), JSON.stringify(input.edges), now, now)
    const id = Number(result.lastInsertRowid)
    return {
      id, name: input.name, description: input.description, workspaceId: input.workspaceId,
      nodes: input.nodes, edges: input.edges, createdAt: now, updatedAt: now,
    }
  }

  getCanvasWorkflow(id: number): CanvasWorkflow | null {
    const row = this.db.prepare('SELECT * FROM canvas_workflows WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return rowToCanvasWorkflow(row)
  }

  listCanvasWorkflows(workspaceId?: number): CanvasWorkflowListItem[] {
    // The last run is joined in rather than fetched per row: the library view
    // shows run state on every card, and a query per workflow would make the
    // page cost grow with the list. The correlated subquery picks one run id
    // per workflow, so the join stays 1:1.
    const select = `
      SELECT w.*,
             r.id          AS last_run_id,
             r.status      AS last_run_status,
             r.started_at  AS last_run_started_at,
             r.finished_at AS last_run_finished_at
      FROM canvas_workflows w
      LEFT JOIN canvas_workflow_runs r
        ON r.id = (
          SELECT id FROM canvas_workflow_runs
          WHERE workflow_id = w.id
          ORDER BY started_at DESC, id DESC
          LIMIT 1
        )
    `
    let rows: Array<Record<string, unknown>>
    if (workspaceId !== undefined) {
      rows = this.db.prepare(
        `${select} WHERE w.workspace_id = ? OR w.workspace_id IS NULL ORDER BY w.created_at DESC`
      ).all(workspaceId) as Array<Record<string, unknown>>
    } else {
      rows = this.db.prepare(`${select} ORDER BY w.created_at DESC`).all() as Array<Record<string, unknown>>
    }
    return rows.map((row) => {
      const workflow = rowToCanvasWorkflow(row) as CanvasWorkflowListItem
      if (row.last_run_id != null) {
        workflow.lastRun = {
          id: row.last_run_id as number,
          status: row.last_run_status as CanvasWorkflowLastRun['status'],
          startedAt: row.last_run_started_at as number,
          finishedAt: (row.last_run_finished_at as number) || undefined,
        }
      }
      return workflow
    })
  }

  updateCanvasWorkflow(id: number, updates: UpdateCanvasWorkflowInput): void {
    const fields: string[] = []
    const values: unknown[] = []
    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name) }
    if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description) }
    if (updates.nodes !== undefined) { fields.push('nodes = ?'); values.push(JSON.stringify(updates.nodes)) }
    if (updates.edges !== undefined) { fields.push('edges = ?'); values.push(JSON.stringify(updates.edges)) }
    fields.push('updated_at = ?')
    values.push(Date.now())
    values.push(id)
    this.db.prepare(`UPDATE canvas_workflows SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }

  deleteCanvasWorkflow(id: number): void {
    this.db.prepare('DELETE FROM canvas_workflows WHERE id = ?').run(id)
  }

  createCanvasRun(workflowId: number): number {
    const result = this.db.prepare(
      `INSERT INTO canvas_workflow_runs (workflow_id, status, started_at) VALUES (?, 'running', ?)`
    ).run(workflowId, Date.now())
    return Number(result.lastInsertRowid)
  }

  updateCanvasRunStatus(runId: number, status: 'success' | 'error', data?: { outputs?: Record<string, string>; error?: string }): void {
    this.db.prepare(
      'UPDATE canvas_workflow_runs SET status = ?, finished_at = ?, outputs = ?, error = ? WHERE id = ?'
    ).run(status, Date.now(), data?.outputs ? JSON.stringify(data.outputs) : null, data?.error ?? null, runId)
  }

  getCanvasRun(runId: number): CanvasWorkflowRun | null {
    const run = this.db.prepare('SELECT * FROM canvas_workflow_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined
    if (!run) return null
    const nodeResults = this.getCanvasNodeResults(runId)
    return {
      id: run.id as number,
      workflowId: run.workflow_id as number,
      status: run.status as CanvasWorkflowRun['status'],
      error: (run.error as string) || undefined,
      startedAt: run.started_at as number,
      finishedAt: (run.finished_at as number) || undefined,
      outputs: run.outputs ? JSON.parse(run.outputs as string) : undefined,
      nodeResults,
    }
  }

  listCanvasRuns(workflowId: number, limit: number = 20): CanvasWorkflowRun[] {
    const rows = this.db.prepare(
      'SELECT id FROM canvas_workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?'
    ).all(workflowId, limit) as Array<{ id: number }>
    return rows.map(row => this.getCanvasRun(row.id)!).filter(Boolean)
  }

  updateCanvasNodeResult(runId: number, nodeId: string, result: NodeResultUpdate): void {
    this.db.prepare(`
      INSERT INTO canvas_node_results (run_id, node_id, status, output, error, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, node_id) DO UPDATE SET
        status = excluded.status,
        output = COALESCE(excluded.output, canvas_node_results.output),
        error = COALESCE(excluded.error, canvas_node_results.error),
        started_at = COALESCE(excluded.started_at, canvas_node_results.started_at),
        finished_at = excluded.finished_at
    `).run(runId, nodeId, result.status, result.output ?? null, result.error ?? null, result.startedAt ?? null, result.finishedAt ?? null)
  }

  getCanvasNodeResults(runId: number): NodeResult[] {
    const rows = this.db.prepare('SELECT * FROM canvas_node_results WHERE run_id = ?').all(runId) as Array<Record<string, unknown>>
    return rows.map(row => ({
      nodeId: row.node_id as string,
      status: row.status as NodeResult['status'],
      output: (row.output as string) || undefined,
      error: (row.error as string) || undefined,
      startedAt: (row.started_at as number) || undefined,
      finishedAt: (row.finished_at as number) || undefined,
    }))
  }

  // ---- Project & Workspace ----

  createProject(input: CreateProjectInput): Project {
    const now = Date.now()
    const result = this.db.prepare(
      'INSERT INTO projects (name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run(input.name, input.rootPath, now, now)
    return {
      id: Number(result.lastInsertRowid),
      name: input.name,
      rootPath: input.rootPath,
      createdAt: now,
      updatedAt: now,
    }
  }

  getProject(id: number): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: row.id as number,
      name: row.name as string,
      rootPath: row.root_path as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }
  }

  listProjects(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>
    return rows.map(row => ({
      id: row.id as number,
      name: row.name as string,
      rootPath: row.root_path as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }))
  }

  deleteProject(id: number): void {
    this.db.prepare('DELETE FROM workspaces WHERE project_id = ?').run(id)
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }

  createWorkspace(projectId: number, input: CreateWorkspaceInput): Workspace {
    const now = Date.now()
    const result = this.db.prepare(
      'INSERT INTO workspaces (project_id, name, branch_name, worktree_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(projectId, input.name, input.branchName, input.worktreePath, now, now)
    return {
      id: Number(result.lastInsertRowid),
      projectId,
      name: input.name,
      branchName: input.branchName,
      worktreePath: input.worktreePath,
      createdAt: now,
      updatedAt: now,
    }
  }

  getWorkspace(id: number): Workspace | null {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: row.id as number,
      projectId: row.project_id as number,
      name: row.name as string,
      branchName: row.branch_name as string,
      worktreePath: row.worktree_path as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }
  }

  listWorkspaces(projectId: number): Workspace[] {
    const rows = this.db.prepare('SELECT * FROM workspaces WHERE project_id = ? ORDER BY created_at ASC').all(projectId) as Array<Record<string, unknown>>
    return rows.map(row => ({
      id: row.id as number,
      projectId: row.project_id as number,
      name: row.name as string,
      branchName: row.branch_name as string,
      worktreePath: row.worktree_path as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }))
  }

  deleteWorkspace(id: number): void {
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
  }

  // ---- Channel: Agents ----

  createAgent(input: CreateAgentInput): Agent {
    const now = Date.now()
    const result = this.db
      .prepare(
        'INSERT INTO agents (name, provider, model, instructions, permission_mode, can_delegate, hidden, env, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.name,
        input.provider,
        input.model,
        input.instructions ?? '',
        input.permissionMode ?? '',
        input.canDelegate ? 1 : 0,
        input.hidden ? 1 : 0,
        JSON.stringify(input.env ?? []),
        now,
      )
    return this.getAgent(result.lastInsertRowid as number)!
  }

  getAgent(id: number): Agent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return rowToAgent(row)
  }

  getAgentByName(name: string): Agent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE name = ?').get(name) as Record<string, unknown> | undefined
    if (!row) return null
    return rowToAgent(row)
  }

  listAgents(): Agent[] {
    const rows = this.db.prepare('SELECT * FROM agents ORDER BY name ASC').all() as Array<Record<string, unknown>>
    return rows.map(rowToAgent)
  }

  updateAgent(id: number, updates: UpdateAgentInput): void {
    // provider is intentionally NOT updatable — switching providers would
    // orphan the LLM-native session state (Claude SDK sessions, Codex session
    // files, Kimi --session ids). Delete + recreate the agent to switch.
    const fields: string[] = []
    const values: unknown[] = []
    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name) }
    if (updates.model !== undefined) { fields.push('model = ?'); values.push(updates.model) }
    if (updates.instructions !== undefined) { fields.push('instructions = ?'); values.push(updates.instructions) }
    if (updates.permissionMode !== undefined) {
      fields.push('permission_mode = ?')
      values.push(updates.permissionMode)
    }
    if (updates.canDelegate !== undefined) {
      fields.push('can_delegate = ?')
      values.push(updates.canDelegate ? 1 : 0)
    }
    if (updates.env !== undefined) {
      fields.push('env = ?')
      values.push(JSON.stringify(updates.env))
    }
    if (fields.length === 0) return
    values.push(id)
    this.db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }

  deleteAgent(id: number): void {
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id)
  }

  // ---- Channel: Channels ----

  createChannel(input: CreateChannelInput): Channel {
    const now = Date.now()
    const result = this.db
      .prepare(
        'INSERT INTO channels (project_id, name, description, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(input.projectId, input.name, input.description ?? '', now)
    return this.getChannel(result.lastInsertRowid as number)!
  }

  getChannel(id: number): Channel | null {
    const row = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: row.id as number,
      projectId: row.project_id as number,
      name: row.name as string,
      description: row.description as string,
      createdAt: row.created_at as number,
    }
  }

  listChannels(projectId: number): Channel[] {
    const rows = this.db
      .prepare('SELECT * FROM channels WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as Array<Record<string, unknown>>
    return rows.map(row => ({
      id: row.id as number,
      projectId: row.project_id as number,
      name: row.name as string,
      description: row.description as string,
      createdAt: row.created_at as number,
    }))
  }

  deleteChannel(id: number): void {
    // No FK cascade in this project (foreign keys are banned), so a channel's
    // dependent rows must be swept explicitly or they orphan. The per-agent app
    // bindings are torn down by the route (that needs runtime disposal via
    // resetBinding); here we drop the pure-DB dependents so no members,
    // messages, or read cursors linger behind the deleted channel.
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM agent_message_cursors WHERE stream_kind = 'app' AND stream_key = ?")
        .run(String(id))
      this.db.prepare('DELETE FROM channel_messages WHERE channel_id = ?').run(id)
      this.db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(id)
      this.db.prepare('DELETE FROM channels WHERE id = ?').run(id)
    })()
  }

  // ---- Channel: Members ----

  addMember(channelId: number, agentId: number): ChannelMember {
    const now = Date.now()
    const result = this.db
      .prepare('INSERT OR IGNORE INTO channel_members (channel_id, agent_id, joined_at) VALUES (?, ?, ?)')
      .run(channelId, agentId, now)
    if (result.changes === 0) {
      // Already exists — return the existing row
      const row = this.db
        .prepare('SELECT * FROM channel_members WHERE channel_id = ? AND agent_id = ?')
        .get(channelId, agentId) as Record<string, unknown>
      return {
        id: row.id as number,
        channelId: row.channel_id as number,
        agentId: row.agent_id as number,
        joinedAt: row.joined_at as number,
      }
    }
    return {
      id: result.lastInsertRowid as number,
      channelId,
      agentId,
      joinedAt: now,
    }
  }

  removeMember(channelId: number, agentId: number): void {
    this.db
      .prepare('DELETE FROM channel_members WHERE channel_id = ? AND agent_id = ?')
      .run(channelId, agentId)
  }

  listMembers(channelId: number): ChannelMember[] {
    const rows = this.db
      .prepare('SELECT * FROM channel_members WHERE channel_id = ? ORDER BY joined_at ASC')
      .all(channelId) as Array<Record<string, unknown>>
    return rows.map(row => ({
      id: row.id as number,
      channelId: row.channel_id as number,
      agentId: row.agent_id as number,
      joinedAt: row.joined_at as number,
    }))
  }

  // ---- Channel: Messages ----

  createMessage(input: CreateMessageInput): ChannelMessage {
    const now = Date.now()
    const result = this.db
      .prepare(
        'INSERT INTO channel_messages (channel_id, thread_root_id, sender_type, sender_id, sender_name, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        input.channelId,
        input.threadRootId ?? null,
        input.senderType,
        input.senderId ?? null,
        input.senderName,
        input.content,
        now
      )
    const id = result.lastInsertRowid as number
    // Update thread root reply_count and last_reply_at if this is a reply
    if (input.threadRootId) {
      this.db
        .prepare(
          'UPDATE channel_messages SET reply_count = reply_count + 1, last_reply_at = ? WHERE id = ?'
        )
        .run(now, input.threadRootId)
    }
    return {
      id,
      channelId: input.channelId,
      threadRootId: input.threadRootId ?? null,
      senderType: input.senderType,
      senderId: input.senderId ?? null,
      senderName: input.senderName,
      content: input.content,
      replyCount: 0,
      lastReplyAt: null,
      createdAt: now,
    }
  }

  private rowToChannelMessage(row: Record<string, unknown>): ChannelMessage {
    return {
      id: row.id as number,
      channelId: row.channel_id as number,
      threadRootId: row.thread_root_id as number | null,
      senderType: row.sender_type as MessageSenderType,
      senderId: row.sender_id as number | null,
      senderName: row.sender_name as string,
      content: row.content as string,
      replyCount: row.reply_count as number,
      lastReplyAt: row.last_reply_at as number | null,
      createdAt: row.created_at as number,
    }
  }

  listMessages(channelId: number, opts?: { before?: number; limit?: number }): { messages: ChannelMessage[]; hasMore: boolean } {
    const limit = opts?.limit ?? 50
    const fetchLimit = limit + 1 // fetch one extra to determine hasMore
    let rows: Array<Record<string, unknown>>
    if (opts?.before) {
      rows = this.db
        .prepare(
          'SELECT * FROM channel_messages WHERE channel_id = ? AND thread_root_id IS NULL AND id < ? ORDER BY id DESC LIMIT ?'
        )
        .all(channelId, opts.before, fetchLimit) as Array<Record<string, unknown>>
    } else {
      // No cursor: fetch the latest N messages
      rows = this.db
        .prepare(
          'SELECT * FROM channel_messages WHERE channel_id = ? AND thread_root_id IS NULL ORDER BY id DESC LIMIT ?'
        )
        .all(channelId, fetchLimit) as Array<Record<string, unknown>>
    }
    const hasMore = rows.length > limit
    if (hasMore) rows = rows.slice(0, limit)
    // Reverse to get ascending order for display
    rows.reverse()
    return { messages: rows.map(row => this.rowToChannelMessage(row)), hasMore }
  }

  listThreadReplies(threadRootId: number): ChannelMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM channel_messages WHERE thread_root_id = ? ORDER BY id ASC')
      .all(threadRootId) as Array<Record<string, unknown>>
    return rows.map(row => this.rowToChannelMessage(row))
  }

  // ---- Project tasks (local Linear) ----

  taskCreate(input: CreateProjectTaskInput): Task {
    const now = Date.now()
    const tx = this.db.transaction((): number => {
      const { n } = this.db
        .prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tasks WHERE project_id = ?')
        .get(input.projectId) as { n: number }
      const res = this.db
        .prepare(
          `INSERT INTO tasks (
             project_id, number, title, description, priority,
             assigned_agent_id, parent_task_id, team_id, source_channel_id, source_chat_id, source_message_id,
             sdd_managed, spec_author_agent_id, plan_anchor, claimed_acs,
             created_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.projectId,
          n,
          input.title,
          input.description ?? '',
          input.priority ?? 0,
          input.assignedAgentId ?? null,
          input.parentTaskId ?? null,
          input.teamId ?? null,
          input.sourceChannelId ?? null,
          input.sourceChatId ?? null,
          input.sourceMessageId ?? null,
          input.sddManaged ? 1 : 0,
          input.specAuthorAgentId ?? null,
          input.planAnchor ?? null,
          input.claimedAcs ? JSON.stringify(input.claimedAcs) : null,
          input.createdBy ?? 'human',
          now,
          now,
        )
      const id = res.lastInsertRowid as number
      if (input.labelIds?.length) this.setTaskLabelsInternal(id, input.labelIds)
      const actorType = input.createdBy === 'agent' ? ('agent' as const) : ('human' as const)
      this.appendActivityInternal(
        id,
        {
          kind: 'system',
          actorType,
          actorId: input.actorId ?? null,
          actorName: input.actorName ?? actorType,
          body: 'created this task',
          meta: null,
        },
        now,
      )
      return id
    })
    return this.taskGet(tx())!
  }

  taskGet(id: number): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.rowToTask(row) : null
  }

  taskGetByNumber(projectId: number, number: number): Task | null {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE project_id = ? AND number = ?')
      .get(projectId, number) as Record<string, unknown> | undefined
    return row ? this.rowToTask(row) : null
  }

  /**
   * Reverse of `tasks.workspace_id`: which task (if any) owns this worktree.
   * Dispatch cuts one worktree per task, so at most one row matches; `LIMIT 1`
   * is a guard against stale rows left by a half-finished cleanup rather than a
   * real one-to-many.
   */
  taskGetByWorkspace(workspaceId: number): Task | null {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE workspace_id = ? ORDER BY id DESC LIMIT 1')
      .get(workspaceId) as Record<string, unknown> | undefined
    return row ? this.rowToTask(row) : null
  }

  taskList(query: ListTasksQuery): TaskListItem[] {
    const where: string[] = ['t.project_id = ?']
    const args: unknown[] = [query.projectId]
    // Archived tasks are hidden unless explicitly requested (keeps the board —
    // and list_project_tasks — focused on live work).
    if (!query.includeArchived) {
      where.push('t.archived_at IS NULL')
    }
    if (query.status !== undefined) {
      where.push('t.status = ?')
      args.push(query.status)
    }
    if (query.assignedAgentId !== undefined) {
      where.push('t.assigned_agent_id = ?')
      args.push(query.assignedAgentId)
    }
    if (query.priority !== undefined) {
      where.push('t.priority = ?')
      args.push(query.priority)
    }
    const join = query.labelId !== undefined ? 'JOIN task_labels tl ON tl.task_id = t.id' : ''
    if (query.labelId !== undefined) {
      where.push('tl.label_id = ?')
      args.push(query.labelId)
    }
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tasks t ${join} WHERE ${where.join(' AND ')} ORDER BY t.priority DESC, t.number ASC`,
      )
      .all(...args) as Array<Record<string, unknown>>
    const tasks = rows.map((r) => this.rowToTask(r))
    const labelsByTask = this.taskLabelsForMany(tasks.map((t) => t.id))
    return tasks.map((t) => ({ ...t, labels: labelsByTask.get(t.id) ?? [] }))
  }

  taskDetail(id: number): TaskDetail | null {
    const task = this.taskGet(id)
    if (!task) return null
    const childTasks = this.taskListChildren(id)
    const childLabels = this.taskLabelsForMany(childTasks.map((t) => t.id))
    return {
      ...task,
      labels: this.taskGetLabels(id),
      activity: this.taskListActivity(id),
      team: task.teamId != null ? this.teamGet(task.teamId) : null,
      children: childTasks.map((t) => ({ ...t, labels: childLabels.get(t.id) ?? [] })),
      // Status of the task's own execution binding (null if never dispatched).
      executionStatus: task.bindingId != null ? (this.getBinding(task.bindingId)?.status ?? null) : null,
    }
  }

  taskUpdate(id: number, updates: UpdateProjectTaskInput, actor?: TaskActor): Task | null {
    const before = this.taskGet(id)
    if (!before) return null
    const now = Date.now()
    const fields: string[] = ['updated_at = ?']
    const values: unknown[] = [now]
    const set = (col: string, val: unknown) => {
      fields.push(`${col} = ?`)
      values.push(val)
    }
    if (updates.title !== undefined) set('title', updates.title)
    if (updates.description !== undefined) set('description', updates.description)
    if (updates.status !== undefined) set('status', updates.status)
    if (updates.priority !== undefined) set('priority', updates.priority)
    if (updates.assignedAgentId !== undefined) set('assigned_agent_id', updates.assignedAgentId)
    if (updates.parentTaskId !== undefined) set('parent_task_id', updates.parentTaskId)
    if (updates.teamId !== undefined) set('team_id', updates.teamId)
    if (updates.branchName !== undefined) set('branch_name', updates.branchName)
    if (updates.workspaceId !== undefined) set('workspace_id', updates.workspaceId)
    if (updates.bindingId !== undefined) set('binding_id', updates.bindingId)
    if (updates.specAuthorAgentId !== undefined) set('spec_author_agent_id', updates.specAuthorAgentId)
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values, id)
      if (updates.labelIds !== undefined) this.setTaskLabelsInternal(id, updates.labelIds)
      if (actor) {
        if (updates.status !== undefined && updates.status !== before.status) {
          this.appendActivityInternal(
            id,
            {
              kind: 'status',
              actorType: actor.type,
              actorId: actor.id ?? null,
              actorName: actor.name,
              body: '',
              meta: { from: before.status, to: updates.status },
            },
            now,
          )
        }
        if (
          updates.assignedAgentId !== undefined &&
          updates.assignedAgentId !== before.assignedAgentId
        ) {
          this.appendActivityInternal(
            id,
            {
              kind: 'assign',
              actorType: actor.type,
              actorId: actor.id ?? null,
              actorName: actor.name,
              body: '',
              meta: { from: before.assignedAgentId, to: updates.assignedAgentId },
            },
            now,
          )
        }
      }
    })
    tx()
    return this.taskGet(id)
  }

  taskSetArchived(id: number, archived: boolean, actor?: TaskActor): Task | null {
    const before = this.taskGet(id)
    if (!before) return null
    // Idempotent: archiving an archived task (or restoring an active one) is a no-op.
    if (archived === (before.archivedAt != null)) return before
    const now = Date.now()
    const tx = this.db.transaction(() => {
      this.db
        .prepare('UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?')
        .run(archived ? now : null, now, id)
      this.appendActivityInternal(
        id,
        {
          kind: 'system',
          actorType: actor?.type ?? 'human',
          actorId: actor?.id ?? null,
          actorName: actor?.name ?? 'You',
          body: archived ? 'archived this task' : 'unarchived this task',
          meta: null,
        },
        now,
      )
    })
    tx()
    return this.taskGet(id)
  }

  taskAppendActivity(taskId: number, entry: TaskActivityInput): TaskActivity {
    return this.appendActivityInternal(taskId, entry, Date.now())
  }

  taskListActivity(taskId: number): TaskActivity[] {
    const rows = this.db
      .prepare('SELECT * FROM task_activity WHERE task_id = ? ORDER BY created_at ASC, id ASC')
      .all(taskId) as Array<Record<string, unknown>>
    return rows.map((r) => this.rowToActivity(r))
  }

  taskListLabelDefs(projectId: number): TaskLabel[] {
    const rows = this.db
      .prepare('SELECT * FROM task_label_defs WHERE project_id = ? ORDER BY name ASC')
      .all(projectId) as Array<Record<string, unknown>>
    return rows.map((r) => this.rowToLabel(r))
  }

  taskCreateLabelDef(input: CreateTaskLabelInput): TaskLabel {
    const now = Date.now()
    const color = input.color ?? '#888888'
    const res = this.db
      .prepare(
        'INSERT INTO task_label_defs (project_id, name, color, is_team, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(input.projectId, input.name, color, input.isTeam ? 1 : 0, now)
    return {
      id: res.lastInsertRowid as number,
      projectId: input.projectId,
      name: input.name,
      color,
      isTeam: !!input.isTeam,
      createdAt: now,
    }
  }

  taskGetLabels(taskId: number): TaskLabel[] {
    return this.taskLabelsForMany([taskId]).get(taskId) ?? []
  }

  // ---- Teams ----

  teamCreate(input: CreateTeamInput): Team {
    const now = Date.now()
    const color = input.color ?? '#8b5cf6'
    const res = this.db
      .prepare('INSERT INTO teams (project_id, name, color, created_at) VALUES (?, ?, ?, ?)')
      .run(input.projectId, input.name, color, now)
    return {
      id: res.lastInsertRowid as number,
      projectId: input.projectId,
      name: input.name,
      color,
      createdAt: now,
    }
  }

  teamUpdate(id: number, updates: UpdateTeamInput): Team | null {
    const existing = this.teamGet(id)
    if (!existing) return null
    const name = updates.name ?? existing.name
    const color = updates.color ?? existing.color
    this.db
      .prepare('UPDATE teams SET name = ?, color = ? WHERE id = ?')
      .run(name, color, id)
    return this.teamGet(id)
  }

  teamDelete(id: number): boolean {
    const tx = this.db.transaction((teamId: number) => {
      this.db.prepare('UPDATE tasks SET team_id = NULL WHERE team_id = ?').run(teamId)
      const res = this.db.prepare('DELETE FROM teams WHERE id = ?').run(teamId)
      return res.changes > 0
    })
    return tx(id) as boolean
  }

  teamList(projectId: number): Team[] {
    const rows = this.db
      .prepare('SELECT * FROM teams WHERE project_id = ? ORDER BY name ASC')
      .all(projectId) as Array<Record<string, unknown>>
    return rows.map((r) => this.rowToTeam(r))
  }

  teamGet(id: number): Team | null {
    const row = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.rowToTeam(row) : null
  }

  taskListByTeam(teamId: number): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE team_id = ? ORDER BY number ASC')
      .all(teamId) as Array<Record<string, unknown>>
    return rows.map((r) => this.rowToTask(r))
  }

  taskListChildren(parentTaskId: number): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY number ASC')
      .all(parentTaskId) as Array<Record<string, unknown>>
    return rows.map((r) => this.rowToTask(r))
  }

  // ---- SDD artifacts (gate state + pointer to change-branch file; §5/§10) ----
  // The canonical content lives on the git change branch at content_ref, never here.

  taskArtifactGet(taskId: number, kind: ArtifactKind): TaskArtifact | null {
    const row = this.db
      .prepare('SELECT * FROM task_artifacts WHERE task_id = ? AND kind = ?')
      .get(taskId, kind) as Record<string, unknown> | undefined
    return row ? this.rowToArtifact(row) : null
  }

  taskArtifactList(taskId: number): TaskArtifact[] {
    const rows = this.db
      .prepare('SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY id ASC')
      .all(taskId) as Array<Record<string, unknown>>
    return rows.map((r) => this.rowToArtifact(r))
  }

  taskArtifactUpsert(taskId: number, kind: ArtifactKind, input: UpsertArtifactInput): TaskArtifact {
    const now = Date.now()
    const existing = this.taskArtifactGet(taskId, kind)
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO task_artifacts
             (task_id, kind, status, approved_by_type, approved_by, approved_at, content_ref, content_sha, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          taskId,
          kind,
          input.status ?? 'draft',
          input.approvedByType ?? null,
          input.approvedBy ?? null,
          input.approvedAt ?? null,
          input.contentRef ?? null,
          input.contentSha ?? null,
          now,
        )
      return this.taskArtifactGet(taskId, kind)!
    }
    const fields: string[] = ['updated_at = ?']
    const values: unknown[] = [now]
    const set = (col: string, val: unknown) => {
      fields.push(`${col} = ?`)
      values.push(val)
    }
    if (input.status !== undefined) set('status', input.status)
    if (input.approvedByType !== undefined) set('approved_by_type', input.approvedByType)
    if (input.approvedBy !== undefined) set('approved_by', input.approvedBy)
    if (input.approvedAt !== undefined) set('approved_at', input.approvedAt)
    if (input.contentRef !== undefined) set('content_ref', input.contentRef)
    if (input.contentSha !== undefined) set('content_sha', input.contentSha)
    this.db
      .prepare(`UPDATE task_artifacts SET ${fields.join(', ')} WHERE task_id = ? AND kind = ?`)
      .run(...values, taskId, kind)
    return this.taskArtifactGet(taskId, kind)!
  }

  private rowToArtifact(row: Record<string, unknown>): TaskArtifact {
    return {
      id: row.id as number,
      taskId: row.task_id as number,
      kind: row.kind as ArtifactKind,
      status: row.status as TaskArtifact['status'],
      approvedByType: (row.approved_by_type as 'human' | 'agent' | null) ?? null,
      approvedBy: (row.approved_by as number | null) ?? null,
      approvedAt: (row.approved_at as number | null) ?? null,
      contentRef: (row.content_ref as string | null) ?? null,
      contentSha: (row.content_sha as string | null) ?? null,
      updatedAt: row.updated_at as number,
    }
  }

  private rowToTeam(row: Record<string, unknown>): Team {
    return {
      id: row.id as number,
      projectId: row.project_id as number,
      name: row.name as string,
      color: row.color as string,
      createdAt: row.created_at as number,
    }
  }

  private setTaskLabelsInternal(taskId: number, labelIds: number[]): void {
    this.db.prepare('DELETE FROM task_labels WHERE task_id = ?').run(taskId)
    const ins = this.db.prepare('INSERT OR IGNORE INTO task_labels (task_id, label_id) VALUES (?, ?)')
    for (const lid of labelIds) ins.run(taskId, lid)
  }

  private taskLabelsForMany(taskIds: number[]): Map<number, TaskLabel[]> {
    const map = new Map<number, TaskLabel[]>()
    if (taskIds.length === 0) return map
    const placeholders = taskIds.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `SELECT tl.task_id AS link_task_id, d.* FROM task_labels tl
           JOIN task_label_defs d ON d.id = tl.label_id
          WHERE tl.task_id IN (${placeholders}) ORDER BY d.name ASC`,
      )
      .all(...taskIds) as Array<Record<string, unknown>>
    for (const row of rows) {
      const tid = row.link_task_id as number
      const list = map.get(tid) ?? []
      list.push(this.rowToLabel(row))
      map.set(tid, list)
    }
    return map
  }

  private appendActivityInternal(
    taskId: number,
    entry: TaskActivityInput,
    now: number,
  ): TaskActivity {
    const res = this.db
      .prepare(
        `INSERT INTO task_activity (task_id, kind, actor_type, actor_id, actor_name, body, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        entry.kind,
        entry.actorType,
        entry.actorId ?? null,
        entry.actorName,
        entry.body ?? '',
        entry.meta != null ? JSON.stringify(entry.meta) : null,
        now,
      )
    return {
      id: res.lastInsertRowid as number,
      taskId,
      kind: entry.kind,
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      actorName: entry.actorName,
      body: entry.body ?? '',
      meta: entry.meta ?? null,
      createdAt: now,
    }
  }

  // ---- Notification inbox ----------------------------------------------------

  notificationUpsert(input: NotifyInput): Notification {
    const now = Date.now()
    // Coalesce: one live (non-archived) row per sourceKey. A repeat event
    // updates the row and re-unreads it rather than stacking a duplicate.
    const existing = this.db
      .prepare('SELECT id FROM notifications WHERE source_key = ? AND archived_at IS NULL')
      .get(input.sourceKey) as { id: number } | undefined
    if (existing) {
      this.db
        .prepare(
          `UPDATE notifications SET
             kind = ?, severity = ?, project_id = ?, workspace_id = ?, chat_id = ?,
             task_id = ?, agent_id = ?, title = ?, body = ?, read_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.kind,
          input.severity,
          input.projectId ?? null,
          input.workspaceId ?? null,
          input.chatId ?? null,
          input.taskId ?? null,
          input.agentId ?? null,
          input.title,
          input.body ?? null,
          now,
          existing.id,
        )
      return this.notificationGet(existing.id)!
    }
    const res = this.db
      .prepare(
        `INSERT INTO notifications (
           kind, severity, project_id, workspace_id, chat_id, task_id, agent_id,
           title, body, source_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.kind,
        input.severity,
        input.projectId ?? null,
        input.workspaceId ?? null,
        input.chatId ?? null,
        input.taskId ?? null,
        input.agentId ?? null,
        input.title,
        input.body ?? null,
        input.sourceKey,
        now,
        now,
      )
    return this.notificationGet(res.lastInsertRowid as number)!
  }

  notificationGet(id: number): Notification | null {
    const row = this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.rowToNotification(row) : null
  }

  notificationList(query: ListNotificationsQuery): Notification[] {
    const clauses = ['archived_at IS NULL']
    const params: unknown[] = []
    if (query.severity) {
      clauses.push('severity = ?')
      params.push(query.severity)
    }
    if (query.unreadOnly) clauses.push('read_at IS NULL')
    if (query.cursor) {
      clauses.push('id < ?')
      params.push(query.cursor)
    }
    params.push(query.limit ?? 50)
    const rows = this.db
      .prepare(
        `SELECT * FROM notifications WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params) as Record<string, unknown>[]
    return rows.map((r) => this.rowToNotification(r))
  }

  notificationMarkRead(ids: number[] | 'all'): number[] {
    const now = Date.now()
    if (ids === 'all') {
      const unread = this.db
        .prepare('SELECT id FROM notifications WHERE read_at IS NULL AND archived_at IS NULL')
        .all() as { id: number }[]
      this.db
        .prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND archived_at IS NULL')
        .run(now)
      return unread.map((r) => r.id)
    }
    const stmt = this.db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL')
    const changed: number[] = []
    for (const id of ids) {
      if (stmt.run(now, id).changes > 0) changed.push(id)
    }
    return changed
  }

  notificationMarkReadBySource(sourceKey: string, kind?: NotificationKind): number[] {
    const now = Date.now()
    const kindClause = kind ? ' AND kind = ?' : ''
    const params: unknown[] = kind ? [sourceKey, kind] : [sourceKey]
    const rows = this.db
      .prepare(
        `SELECT id FROM notifications
         WHERE source_key = ?${kindClause} AND read_at IS NULL AND archived_at IS NULL`,
      )
      .all(...params) as { id: number }[]
    if (rows.length === 0) return []
    const stmt = this.db.prepare('UPDATE notifications SET read_at = ? WHERE id = ?')
    for (const row of rows) stmt.run(now, row.id)
    return rows.map((r) => r.id)
  }

  notificationArchive(ids: number[] | 'all'): number[] {
    const now = Date.now()
    if (ids === 'all') {
      const live = this.db
        .prepare('SELECT id FROM notifications WHERE archived_at IS NULL')
        .all() as { id: number }[]
      this.db.prepare('UPDATE notifications SET archived_at = ? WHERE archived_at IS NULL').run(now)
      return live.map((r) => r.id)
    }
    const stmt = this.db.prepare(
      'UPDATE notifications SET archived_at = ? WHERE id = ? AND archived_at IS NULL',
    )
    const changed: number[] = []
    for (const id of ids) {
      if (stmt.run(now, id).changes > 0) changed.push(id)
    }
    return changed
  }

  notificationUnreadCounts(): UnreadCounts {
    const total = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL AND archived_at IS NULL')
        .get() as { n: number }
    ).n
    const action = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL AND archived_at IS NULL AND severity = 'action'",
        )
        .get() as { n: number }
    ).n
    return { total, action }
  }

  private rowToNotification(row: Record<string, unknown>): Notification {
    return {
      id: row.id as number,
      kind: row.kind as NotificationKind,
      severity: row.severity as NotificationSeverity,
      projectId: (row.project_id as number | null) ?? null,
      workspaceId: (row.workspace_id as number | null) ?? null,
      chatId: (row.chat_id as number | null) ?? null,
      taskId: (row.task_id as number | null) ?? null,
      agentId: (row.agent_id as number | null) ?? null,
      title: row.title as string,
      body: (row.body as string | null) ?? null,
      sourceKey: row.source_key as string,
      readAt: (row.read_at as number | null) ?? null,
      archivedAt: (row.archived_at as number | null) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }
  }

  private rowToTask(row: Record<string, unknown>): Task {
    return {
      id: row.id as number,
      projectId: row.project_id as number,
      number: row.number as number,
      title: row.title as string,
      description: (row.description as string) ?? '',
      status: row.status as ProjectTaskStatus,
      priority: row.priority as TaskPriority,
      assignedAgentId: (row.assigned_agent_id as number | null) ?? null,
      parentTaskId: (row.parent_task_id as number | null) ?? null,
      teamId: (row.team_id as number | null) ?? null,
      sourceChannelId: (row.source_channel_id as number | null) ?? null,
      sourceChatId: (row.source_chat_id as number | null) ?? null,
      sourceMessageId: (row.source_message_id as number | null) ?? null,
      branchName: (row.branch_name as string | null) ?? null,
      workspaceId: (row.workspace_id as number | null) ?? null,
      bindingId: (row.binding_id as number | null) ?? null,
      sddManaged: !!(row.sdd_managed as number),
      specAuthorAgentId: (row.spec_author_agent_id as number | null) ?? null,
      planAnchor: (row.plan_anchor as string | null) ?? null,
      claimedAcs: row.claimed_acs ? (JSON.parse(row.claimed_acs as string) as string[]) : null,
      createdBy: row.created_by as Task['createdBy'],
      archivedAt: (row.archived_at as number | null) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }
  }

  private rowToLabel(row: Record<string, unknown>): TaskLabel {
    return {
      id: row.id as number,
      projectId: row.project_id as number,
      name: row.name as string,
      color: row.color as string,
      isTeam: !!(row.is_team as number),
      createdAt: row.created_at as number,
    }
  }

  private rowToActivity(row: Record<string, unknown>): TaskActivity {
    const metaRaw = row.meta as string | null
    return {
      id: row.id as number,
      taskId: row.task_id as number,
      kind: row.kind as TaskActivity['kind'],
      actorType: row.actor_type as TaskActivity['actorType'],
      actorId: (row.actor_id as number | null) ?? null,
      actorName: row.actor_name as string,
      body: (row.body as string) ?? '',
      meta: metaRaw ? (JSON.parse(metaRaw) as Record<string, unknown>) : null,
      createdAt: row.created_at as number,
    }
  }

  // ---- Channel: unread messages (cursor lives in agent_message_cursors) ----

  getUnreadChannelMessages(agentId: number, channelId: number): ChannelMessage[] {
    const cursor = this.getCursor(agentId, 'app', String(channelId))
    const lastReadId = cursor?.lastReadId ?? 0
    const rows = this.db
      .prepare(
        'SELECT * FROM channel_messages WHERE channel_id = ? AND id > ? ORDER BY id ASC'
      )
      .all(channelId, lastReadId) as Array<Record<string, unknown>>
    return rows.map(row => this.rowToChannelMessage(row))
  }

  // ---- IM: Providers ----

  createIMProvider(input: CreateIMProviderInput): IMProviderRecord {
    const now = Date.now()
    const stmt = this.db.prepare(
      `INSERT INTO im_providers (
         source, instance_id, mode, agent_id, self_user_id, self_bot_id,
         display_name, credentials_json, config_json, enabled, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const res = stmt.run(
      input.source,
      input.instanceId,
      input.mode,
      input.agentId ?? null,
      input.selfUserId,
      input.selfBotId ?? null,
      input.displayName,
      input.credentialsJson,
      input.configJson ?? null,
      input.enabled === false ? 0 : 1,
      now,
      now,
    )
    const id = Number(res.lastInsertRowid)
    const record = this.getIMProvider(id)
    if (!record) throw new Error(`createIMProvider: row ${id} not found after insert`)
    return record
  }

  getIMProvider(id: number): IMProviderRecord | null {
    const row = this.db.prepare('SELECT * FROM im_providers WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.rowToIMProvider(row) : null
  }

  getIMProviderByInstance(source: IMSource, instanceId: string): IMProviderRecord | null {
    const row = this.db
      .prepare('SELECT * FROM im_providers WHERE source = ? AND instance_id = ?')
      .get(source, instanceId) as Record<string, unknown> | undefined
    return row ? this.rowToIMProvider(row) : null
  }

  listIMProviders(filter: { source?: IMSource; enabled?: boolean } = {}): IMProviderRecord[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (filter.source) {
      clauses.push('source = ?')
      params.push(filter.source)
    }
    if (filter.enabled !== undefined) {
      clauses.push('enabled = ?')
      params.push(filter.enabled ? 1 : 0)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM im_providers ${where} ORDER BY id ASC`)
      .all(...params) as Array<Record<string, unknown>>
    return rows.map((r) => this.rowToIMProvider(r))
  }

  updateIMProvider(id: number, updates: UpdateIMProviderInput): void {
    const sets: string[] = []
    const params: unknown[] = []
    const push = (col: string, val: unknown) => {
      sets.push(`${col} = ?`)
      params.push(val)
    }
    if (updates.instanceId !== undefined) push('instance_id', updates.instanceId)
    if (updates.agentId !== undefined) push('agent_id', updates.agentId)
    if (updates.selfUserId !== undefined) push('self_user_id', updates.selfUserId)
    if (updates.selfBotId !== undefined) push('self_bot_id', updates.selfBotId)
    if (updates.displayName !== undefined) push('display_name', updates.displayName)
    if (updates.credentialsJson !== undefined) push('credentials_json', updates.credentialsJson)
    if (updates.configJson !== undefined) push('config_json', updates.configJson)
    if (updates.enabled !== undefined) push('enabled', updates.enabled ? 1 : 0)
    if (sets.length === 0) return
    push('updated_at', Date.now())
    params.push(id)
    this.db.prepare(`UPDATE im_providers SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }

  deleteIMProvider(id: number): void {
    this.db.prepare('DELETE FROM im_providers WHERE id = ?').run(id)
  }

  // ---- IM: Messages ----

  insertIMMessage(input: CreateIMMessageInput): IMInsertResult {
    const now = Date.now()
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO im_messages (
           recipient_agent_id, source, source_channel, source_ts, sender_kind, sender_id, sender_name,
           sender_agent_id, text, thread_ref, reply_to_ref, attachments_json, raw_json, received_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.recipientAgentId,
        input.source,
        input.sourceChannel,
        input.sourceTs,
        input.senderKind,
        input.senderId,
        input.senderName,
        input.senderAgentId ?? null,
        input.text,
        input.threadRef ?? null,
        input.replyToRef ?? null,
        input.attachmentsJson ?? null,
        input.rawJson ?? null,
        now,
      )
    const inserted = res.changes > 0
    const row = this.db
      .prepare(
        `SELECT * FROM im_messages
         WHERE recipient_agent_id = ? AND source = ? AND source_channel = ? AND source_ts = ?`
      )
      .get(
        input.recipientAgentId,
        input.source,
        input.sourceChannel,
        input.sourceTs,
      ) as Record<string, unknown>
    return { inserted, row: this.rowToIMMessage(row) }
  }

  getIMMessage(id: number): IMMessageRow | null {
    const row = this.db.prepare('SELECT * FROM im_messages WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.rowToIMMessage(row) : null
  }

  getIMMessageByNativeTs(
    recipientAgentId: number,
    source: IMSource,
    sourceChannel: string,
    sourceTs: string,
  ): IMMessageRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM im_messages
         WHERE recipient_agent_id = ? AND source = ? AND source_channel = ? AND source_ts = ?`
      )
      .get(recipientAgentId, source, sourceChannel, sourceTs) as Record<string, unknown> | undefined
    return row ? this.rowToIMMessage(row) : null
  }

  listIMMessages(
    source: IMSource,
    sourceChannel: string,
    opts: { afterId?: number; beforeId?: number; limit?: number; recipientAgentId?: number } = {},
  ): IMMessageRow[] {
    const clauses = ['source = ?', 'source_channel = ?']
    const params: unknown[] = [source, sourceChannel]
    if (opts.recipientAgentId !== undefined) {
      clauses.push('recipient_agent_id = ?')
      params.push(opts.recipientAgentId)
    }
    if (opts.afterId !== undefined) {
      clauses.push('id > ?')
      params.push(opts.afterId)
    }
    if (opts.beforeId !== undefined) {
      clauses.push('id < ?')
      params.push(opts.beforeId)
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 2000))
    params.push(limit)
    const rows = this.db
      .prepare(
        `SELECT * FROM im_messages WHERE ${clauses.join(' AND ')} ORDER BY id ASC LIMIT ?`
      )
      .all(...params) as Array<Record<string, unknown>>
    return rows.map((r) => this.rowToIMMessage(r))
  }

  getUnreadIMMessages(
    agentId: number,
    source: IMSource,
    sourceChannel: string,
    limit = 500,
  ): IMMessageRow[] {
    // Rows scoped to this agent's inbox: recipient_agent_id = agentId.
    // (Pre-0020 legacy rows have NULL recipient and are intentionally invisible.)
    //
    // We still exclude self-echo via sender_agent_id != self. Even though
    // per-recipient ownership already separates streams, an agent's own
    // outbound write enters its own inbox too (the post-send echo path);
    // dropping it here keeps handleMateFinish from re-waking on its own reply.
    const streamKey = `${source}:${sourceChannel}`
    const cursor = this.getCursor(agentId, 'mate', streamKey)
    const lastReadId = cursor?.lastReadId ?? 0
    const bounded = Math.max(1, Math.min(limit, 2000))
    const rows = this.db
      .prepare(
        `SELECT * FROM im_messages
         WHERE recipient_agent_id = ? AND source = ? AND source_channel = ? AND id > ?
           AND (sender_agent_id IS NULL OR sender_agent_id != ?)
         ORDER BY id ASC LIMIT ?`,
      )
      .all(agentId, source, sourceChannel, lastReadId, agentId, bounded) as Array<Record<string, unknown>>
    return rows.map((r) => this.rowToIMMessage(r))
  }

  // ---- IM: interactive chat routing ----

  upsertIMInteractiveChat(input: UpsertIMInteractiveChatInput): IMInteractiveChat {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO im_interactive_chats (source, external_id, chat_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source, external_id) DO UPDATE SET
           chat_id    = excluded.chat_id,
           updated_at = excluded.updated_at`
      )
      .run(input.source, input.externalId, input.chatId, now, now)
    const row = this.getIMInteractiveChat(input.source, input.externalId)
    if (!row) throw new Error(`upsertIMInteractiveChat: row missing after upsert`)
    return row
  }

  getIMInteractiveChat(source: IMSource, externalId: string): IMInteractiveChat | null {
    const row = this.db
      .prepare('SELECT * FROM im_interactive_chats WHERE source = ? AND external_id = ?')
      .get(source, externalId) as Record<string, unknown> | undefined
    return row ? this.rowToIMInteractiveChat(row) : null
  }

  getIMInteractiveChatByChatId(chatId: number): IMInteractiveChat | null {
    const row = this.db
      .prepare('SELECT * FROM im_interactive_chats WHERE chat_id = ?')
      .get(chatId) as Record<string, unknown> | undefined
    return row ? this.rowToIMInteractiveChat(row) : null
  }

  deleteIMInteractiveChat(source: IMSource, externalId: string): void {
    this.db
      .prepare('DELETE FROM im_interactive_chats WHERE source = ? AND external_id = ?')
      .run(source, externalId)
  }

  listIMInteractiveChatsBySource(source: IMSource): IMInteractiveChat[] {
    const rows = this.db
      .prepare('SELECT * FROM im_interactive_chats WHERE source = ? ORDER BY chat_id ASC')
      .all(source) as Array<Record<string, unknown>>
    return rows.map((r) => this.rowToIMInteractiveChat(r))
  }

  private rowToIMInteractiveChat(row: Record<string, unknown>): IMInteractiveChat {
    return {
      source: row.source as IMSource,
      externalId: row.external_id as string,
      chatId: row.chat_id as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }
  }

  // ---- IM: row mappers ----

  private rowToIMProvider(row: Record<string, unknown>): IMProviderRecord {
    return {
      id: row.id as number,
      source: row.source as IMSource,
      instanceId: row.instance_id as string,
      mode: row.mode as IMProviderMode,
      agentId: (row.agent_id as number | null) ?? null,
      selfUserId: row.self_user_id as string,
      selfBotId: (row.self_bot_id as string | null) ?? null,
      displayName: row.display_name as string,
      credentialsJson: row.credentials_json as string,
      configJson: (row.config_json as string | null) ?? null,
      enabled: (row.enabled as number) === 1,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }
  }

  // ---- AgentBindingStorageAdapter ----

  upsertBinding(input: UpsertAgentBindingInput): AgentBinding {
    const now = Date.now()
    const existing = this.getBindingByScope(input.scopeKind, input.scopeKey, input.agentId)
    const status = input.status ?? existing?.status ?? 'offline'
    const channelKind = input.channelKind ?? existing?.channelKind ?? 'channel'
    const metaJson = serializeMetadata(input.metadata)
    if (existing) {
      this.db
        .prepare(
          `UPDATE agent_bindings SET
             scope_display_name      = COALESCE(?, scope_display_name),
             channel_kind            = ?,
             project_id              = COALESCE(?, project_id),
             workspace_id            = COALESCE(?, workspace_id),
             active_chat_id          = COALESCE(?, active_chat_id),
             status                  = ?,
             im_provider_instance_id = COALESCE(?, im_provider_instance_id),
             agent_session_id        = COALESCE(?, agent_session_id),
             team_label              = COALESCE(?, team_label),
             metadata                = COALESCE(?, metadata),
             updated_at              = ?
           WHERE id = ?`
        )
        .run(
          input.scopeDisplayName ?? null,
          channelKind,
          input.projectId ?? null,
          input.workspaceId ?? null,
          input.activeChatId ?? null,
          status,
          input.imProviderInstanceId ?? null,
          input.agentSessionId ?? null,
          input.teamLabel ?? null,
          metaJson,
          now,
          existing.id,
        )
      return this.getBinding(existing.id)!
    }
    const result = this.db
      .prepare(
        `INSERT INTO agent_bindings (
           agent_id, scope_kind, scope_key, scope_display_name, channel_kind,
           project_id, workspace_id, active_chat_id, status,
           im_provider_instance_id, agent_session_id, team_label, metadata,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.agentId,
        input.scopeKind,
        input.scopeKey,
        input.scopeDisplayName ?? null,
        channelKind,
        input.projectId ?? null,
        input.workspaceId ?? null,
        input.activeChatId ?? null,
        status,
        input.imProviderInstanceId ?? null,
        input.agentSessionId ?? null,
        input.teamLabel ?? null,
        metaJson,
        now,
        now,
      )
    return this.getBinding(Number(result.lastInsertRowid))!
  }

  updateBinding(id: number, updates: UpdateAgentBindingInput): void {
    const fields: string[] = []
    const values: unknown[] = []
    const push = (col: string, value: unknown): void => {
      fields.push(`${col} = ?`)
      values.push(value)
    }
    if ('scopeDisplayName' in updates) push('scope_display_name', updates.scopeDisplayName ?? null)
    if ('projectId' in updates) push('project_id', updates.projectId ?? null)
    if ('workspaceId' in updates) push('workspace_id', updates.workspaceId ?? null)
    if ('activeChatId' in updates) push('active_chat_id', updates.activeChatId ?? null)
    if ('status' in updates && updates.status !== undefined) push('status', updates.status)
    if ('imProviderInstanceId' in updates) push('im_provider_instance_id', updates.imProviderInstanceId ?? null)
    if ('agentSessionId' in updates) push('agent_session_id', updates.agentSessionId ?? null)
    if ('teamLabel' in updates) push('team_label', updates.teamLabel ?? null)
    if ('metadata' in updates) push('metadata', serializeMetadata(updates.metadata ?? null))
    if (fields.length === 0) return
    push('updated_at', Date.now())
    values.push(id)
    this.db
      .prepare(`UPDATE agent_bindings SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values)
  }

  deleteBinding(id: number): void {
    this.db.prepare('DELETE FROM agent_bindings WHERE id = ?').run(id)
  }

  getBinding(id: number): AgentBinding | null {
    const row = this.db
      .prepare('SELECT * FROM agent_bindings WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined
    return row ? this.rowToAgentBinding(row) : null
  }

  getBindingByScope(
    scopeKind: BindingScopeKind,
    scopeKey: string,
    agentId: number,
  ): AgentBinding | null {
    const row = this.db
      .prepare(
        'SELECT * FROM agent_bindings WHERE scope_kind = ? AND scope_key = ? AND agent_id = ?'
      )
      .get(scopeKind, scopeKey, agentId) as Record<string, unknown> | undefined
    return row ? this.rowToAgentBinding(row) : null
  }

  getBindingByAgentSessionId(agentSessionId: string): AgentBinding | null {
    const row = this.db
      .prepare('SELECT * FROM agent_bindings WHERE agent_session_id = ?')
      .get(agentSessionId) as Record<string, unknown> | undefined
    return row ? this.rowToAgentBinding(row) : null
  }

  getBindingByActiveChatId(chatId: number): AgentBinding | null {
    const row = this.db
      .prepare('SELECT * FROM agent_bindings WHERE active_chat_id = ?')
      .get(chatId) as Record<string, unknown> | undefined
    return row ? this.rowToAgentBinding(row) : null
  }

  listBindings(query: ListBindingsQuery): AgentBinding[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (query.scopeKind !== undefined) {
      clauses.push('scope_kind = ?')
      params.push(query.scopeKind)
    }
    if (query.agentId !== undefined) {
      clauses.push('agent_id = ?')
      params.push(query.agentId)
    }
    if (query.projectId !== undefined) {
      clauses.push('project_id = ?')
      params.push(query.projectId)
    }
    if (query.imProviderInstanceId !== undefined) {
      clauses.push('im_provider_instance_id = ?')
      params.push(query.imProviderInstanceId)
    }
    if (query.teamLabel !== undefined) {
      clauses.push('team_label = ?')
      params.push(query.teamLabel)
    }
    if (query.status !== undefined) {
      clauses.push('status = ?')
      params.push(query.status)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM agent_bindings ${where} ORDER BY id ASC`)
      .all(...params) as Array<Record<string, unknown>>
    return rows.map((r) => this.rowToAgentBinding(r))
  }

  listBindingsForScope(scopeKind: BindingScopeKind, scopeKey: string): AgentBinding[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM agent_bindings WHERE scope_kind = ? AND scope_key = ? ORDER BY id ASC'
      )
      .all(scopeKind, scopeKey) as Array<Record<string, unknown>>
    return rows.map((r) => this.rowToAgentBinding(r))
  }

  // ---- Unified message cursors ----

  getCursor(agentId: number, streamKind: CursorStreamKind, streamKey: string): AgentMessageCursor | null {
    const row = this.db
      .prepare(
        'SELECT * FROM agent_message_cursors WHERE agent_id = ? AND stream_kind = ? AND stream_key = ?'
      )
      .get(agentId, streamKind, streamKey) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      agentId: row.agent_id as number,
      streamKind: row.stream_kind as CursorStreamKind,
      streamKey: row.stream_key as string,
      lastReadId: row.last_read_id as number,
      updatedAt: row.updated_at as number,
    }
  }

  upsertCursor(
    agentId: number,
    streamKind: CursorStreamKind,
    streamKey: string,
    lastReadId: number,
  ): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO agent_message_cursors (agent_id, stream_kind, stream_key, last_read_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, stream_kind, stream_key) DO UPDATE SET
           last_read_id = MAX(agent_message_cursors.last_read_id, excluded.last_read_id),
           updated_at   = excluded.updated_at`
      )
      .run(agentId, streamKind, streamKey, lastReadId, now)
  }

  // ---- Inbox ----

  insertInboxMessage(input: CreateAgentInboxMessageInput): AgentInboxMessageRow {
    const now = Date.now()
    const result = this.db
      .prepare(
        `INSERT INTO agent_inbox_messages (
           recipient_agent_id, sender_agent_id, sender_name, content,
           ref_kind, ref_id, metadata, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.recipientAgentId,
        input.senderAgentId ?? null,
        input.senderName,
        input.content,
        input.refKind ?? null,
        input.refId ?? null,
        serializeMetadata(input.metadata ?? null),
        now,
      )
    return this.getInboxMessage(Number(result.lastInsertRowid))!
  }

  getInboxMessage(id: number): AgentInboxMessageRow | null {
    const row = this.db
      .prepare('SELECT * FROM agent_inbox_messages WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined
    return row ? this.rowToInboxMessage(row) : null
  }

  getUnreadInboxMessages(
    agentId: number,
    opts: { scopeDisplayName?: string | null; limit?: number } = {},
  ): AgentInboxMessageRow[] {
    const scope = opts.scopeDisplayName ?? null
    const cursorKey = scope ?? ''
    const cursor = this.getCursor(agentId, 'inbox', cursorKey)
    const lastReadId = cursor?.lastReadId ?? 0
    const bounded = Math.max(1, Math.min(opts.limit ?? 50, 200))
    const params: unknown[] = [agentId, lastReadId]
    let scopeClause = ''
    if (scope !== null) {
      scopeClause = ' AND (ref_id = ? OR ref_id IS NULL)'
      params.push(scope)
    }
    params.push(bounded)
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_inbox_messages
         WHERE recipient_agent_id = ? AND id > ?${scopeClause}
         ORDER BY id ASC LIMIT ?`
      )
      .all(...params) as Array<Record<string, unknown>>
    return rows.map((r) => this.rowToInboxMessage(r))
  }

  listInboxMessages(
    agentId: number,
    opts: { senderAgentId?: number; beforeId?: number; afterId?: number; limit?: number } = {},
  ): AgentInboxMessageRow[] {
    const clauses = ['recipient_agent_id = ?']
    const params: unknown[] = [agentId]
    if (opts.senderAgentId !== undefined) {
      clauses.push('sender_agent_id = ?')
      params.push(opts.senderAgentId)
    }
    if (opts.beforeId !== undefined) {
      clauses.push('id < ?')
      params.push(opts.beforeId)
    }
    if (opts.afterId !== undefined) {
      clauses.push('id > ?')
      params.push(opts.afterId)
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 500))
    params.push(limit)
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_inbox_messages WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`
      )
      .all(...params) as Array<Record<string, unknown>>
    return rows.map((r) => this.rowToInboxMessage(r))
  }

  // ---- Row mappers ----

  private rowToAgentBinding(row: Record<string, unknown>): AgentBinding {
    return {
      id: row.id as number,
      agentId: row.agent_id as number,
      scopeKind: row.scope_kind as BindingScopeKind,
      scopeKey: row.scope_key as string,
      scopeDisplayName: (row.scope_display_name as string | null) ?? null,
      channelKind: row.channel_kind as BindingChannelKind,
      projectId: (row.project_id as number | null) ?? null,
      workspaceId: (row.workspace_id as number | null) ?? null,
      activeChatId: (row.active_chat_id as number | null) ?? null,
      status: row.status as BindingStatus,
      imProviderInstanceId: (row.im_provider_instance_id as number | null) ?? null,
      agentSessionId: (row.agent_session_id as string | null) ?? null,
      teamLabel: (row.team_label as string | null) ?? null,
      metadata: parseMetadata(row.metadata),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }
  }

  private rowToInboxMessage(row: Record<string, unknown>): AgentInboxMessageRow {
    return {
      id: row.id as number,
      recipientAgentId: row.recipient_agent_id as number,
      senderAgentId: (row.sender_agent_id as number | null) ?? null,
      senderName: row.sender_name as string,
      content: row.content as string,
      refKind: (row.ref_kind as InboxRefKind | null) ?? null,
      refId: (row.ref_id as string | null) ?? null,
      metadata: parseMetadata(row.metadata),
      createdAt: row.created_at as number,
    }
  }

  private rowToIMMessage(row: Record<string, unknown>): IMMessageRow {
    return {
      id: row.id as number,
      recipientAgentId: (row.recipient_agent_id as number | null) ?? null,
      source: row.source as IMSource,
      sourceChannel: row.source_channel as string,
      sourceTs: row.source_ts as string,
      senderKind: row.sender_kind as IMSenderKind,
      senderId: row.sender_id as string,
      senderName: row.sender_name as string,
      senderAgentId: (row.sender_agent_id as number | null) ?? null,
      text: row.text as string,
      threadRef: (row.thread_ref as string | null) ?? null,
      replyToRef: (row.reply_to_ref as string | null) ?? null,
      attachmentsJson: (row.attachments_json as string | null) ?? null,
      rawJson: (row.raw_json as string | null) ?? null,
      receivedAt: row.received_at as number,
    }
  }

  // ---- Mobile Pairing ----

  insertMobilePairing(input: CreateMobilePairingInput): MobilePairingRow {
    const now = Date.now()
    const confirmedAt = input.status === 'confirmed' ? now : null
    const result = this.db
      .prepare(
        `INSERT INTO chat_mobile_pairings
         (desktop_id, mobile_device_id, mobile_public_key, mobile_fingerprint, mobile_label,
          pairing_nonce, status, created_at, confirmed_at, revoked_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(desktop_id, mobile_device_id) DO UPDATE SET
           mobile_public_key = excluded.mobile_public_key,
           mobile_fingerprint = excluded.mobile_fingerprint,
           mobile_label = excluded.mobile_label,
           pairing_nonce = excluded.pairing_nonce,
           status = excluded.status,
           confirmed_at = excluded.confirmed_at,
           revoked_at = NULL,
           last_seen_at = NULL`
      )
      .run(
        input.desktopId,
        input.mobileDeviceId,
        Buffer.from(input.mobilePublicKey),
        input.mobileFingerprint,
        input.mobileLabel ?? null,
        input.pairingNonce,
        input.status,
        now,
        confirmedAt
      )
      void result
    const row = this.db
      .prepare(
        'SELECT * FROM chat_mobile_pairings WHERE desktop_id = ? AND mobile_device_id = ?'
      )
      .get(input.desktopId, input.mobileDeviceId) as Record<string, unknown>
    return rowToMobilePairing(row)
  }

  getMobilePairingByNonce(pairingNonce: string): MobilePairingRow | null {
    const row = this.db
      .prepare('SELECT * FROM chat_mobile_pairings WHERE pairing_nonce = ? ORDER BY created_at DESC LIMIT 1')
      .get(pairingNonce) as Record<string, unknown> | undefined
    return row ? rowToMobilePairing(row) : null
  }

  getMobilePairingByDevice(desktopId: string, mobileDeviceId: string): MobilePairingRow | null {
    const row = this.db
      .prepare('SELECT * FROM chat_mobile_pairings WHERE desktop_id = ? AND mobile_device_id = ?')
      .get(desktopId, mobileDeviceId) as Record<string, unknown> | undefined
    return row ? rowToMobilePairing(row) : null
  }

  listMobilePairings(desktopId: string): MobilePairingRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM chat_mobile_pairings
         WHERE desktop_id = ? AND status != 'revoked'
         ORDER BY created_at DESC`
      )
      .all(desktopId) as Array<Record<string, unknown>>
    return rows.map(rowToMobilePairing)
  }

  confirmMobilePairing(pairingNonce: string, confirmedAt: number): MobilePairingRow | null {
    const current = this.getMobilePairingByNonce(pairingNonce)
    if (!current) return null
    if (current.status === 'revoked') return null
    this.db
      .prepare(
        `UPDATE chat_mobile_pairings
         SET status = 'confirmed', confirmed_at = ?
         WHERE id = ?`
      )
      .run(confirmedAt, current.id)
    return this.getMobilePairingByDevice(current.desktopId, current.mobileDeviceId)
  }

  setMobilePairingStatus(id: number, status: MobilePairingStatus, ts: number): void {
    if (status === 'revoked') {
      this.db
        .prepare('UPDATE chat_mobile_pairings SET status = ?, revoked_at = ? WHERE id = ?')
        .run(status, ts, id)
      return
    }
    if (status === 'confirmed') {
      this.db
        .prepare('UPDATE chat_mobile_pairings SET status = ?, confirmed_at = ? WHERE id = ?')
        .run(status, ts, id)
      return
    }
    this.db
      .prepare('UPDATE chat_mobile_pairings SET status = ? WHERE id = ?')
      .run(status, id)
  }

  touchMobilePairingLastSeen(desktopId: string, mobileDeviceId: string, ts: number): void {
    this.db
      .prepare(
        `UPDATE chat_mobile_pairings
         SET last_seen_at = ?
         WHERE desktop_id = ? AND mobile_device_id = ?`
      )
      .run(ts, desktopId, mobileDeviceId)
  }

  close(): void {
    this.db.close()
  }
}

/** Escape LIKE special characters */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, (ch) => '\\' + ch)
}

function rowToAgent(row: Record<string, unknown>): Agent {
  return {
    id: row.id as number,
    name: row.name as string,
    provider: row.provider as string,
    model: row.model as string,
    instructions: row.instructions as string,
    permissionMode: (row.permission_mode as string | null) ?? '',
    canDelegate: ((row.can_delegate as number | null) ?? 0) === 1,
    hidden: ((row.hidden as number | null) ?? 0) === 1,
    env: parseAgentEnv(row.env),
    createdAt: row.created_at as number,
  }
}

function parseAgentEnv(raw: unknown): Agent['env'] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: Agent['env'] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const r = item as Record<string, unknown>
      const key = typeof r.key === 'string' ? r.key : ''
      const value = typeof r.value === 'string' ? r.value : ''
      const enabled = r.enabled === true
      if (!key) continue
      out.push({ key, value, enabled })
    }
    return out
  } catch {
    return []
  }
}

function parseJsonOrRaw(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function rowToMobilePairing(row: Record<string, unknown>): MobilePairingRow {
  const blob = row.mobile_public_key as Buffer | Uint8Array
  const publicKey = blob instanceof Uint8Array ? new Uint8Array(blob) : Uint8Array.from(blob as Buffer)
  return {
    id: row.id as number,
    desktopId: row.desktop_id as string,
    mobileDeviceId: row.mobile_device_id as string,
    mobilePublicKey: publicKey,
    mobileFingerprint: row.mobile_fingerprint as string,
    mobileLabel: (row.mobile_label as string | null) ?? null,
    pairingNonce: row.pairing_nonce as string,
    status: row.status as MobilePairingStatus,
    createdAt: row.created_at as number,
    confirmedAt: (row.confirmed_at as number | null) ?? null,
    revokedAt: (row.revoked_at as number | null) ?? null,
    lastSeenAt: (row.last_seen_at as number | null) ?? null,
  }
}

function toCronjobScheduleSql(schedule: CronjobSchedule): CronjobScheduleSqlValue {
  return {
    type: 'daily',
    time: schedule.time,
    days: JSON.stringify(schedule.days),
    intervalMinutes:
      schedule.intervalMinutes != null && Number.isFinite(schedule.intervalMinutes)
        ? Math.max(1, Math.floor(schedule.intervalMinutes))
        : null,
    endTime: schedule.intervalMinutes != null ? schedule.endTime ?? '23:59' : null,
  }
}

function rowToCronjobTask(row: CronjobRow): CronjobTask {
  const schedule = toCronjobSchedule(row)
  const status = toCronjobResultStatus(row.last_result_status)
  const hasLastResult =
    status !== null && row.last_result_finished_at !== null && row.last_result_duration_ms !== null

  let lastResult: CronjobRunResult | undefined
  if (hasLastResult) {
    lastResult = {
      status,
      output: row.last_result_output ?? undefined,
      error: row.last_result_error ?? undefined,
      finishedAt: row.last_result_finished_at!,
      durationMs: row.last_result_duration_ms!,
    }
  }

  const taskType = row.task_type === 'canvas-workflow' ? 'canvas-workflow' as const : 'chat' as const

  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    taskType,
    canvasWorkflowId: row.canvas_workflow_id ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    providerId: row.provider_id,
    modelId: row.model_id ?? undefined,
    modeId: row.mode_id ?? undefined,
    thinkingLevel: row.thinking_level ?? undefined,
    prompt: row.prompt,
    schedule,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at ?? undefined,
    nextRunAt: row.next_run_at ?? undefined,
    lastResult,
  }
}

function toCronjobSchedule(row: CronjobRow): CronjobSchedule {
  const schedule: CronjobSchedule = {
    type: 'daily',
    time: row.schedule_time ?? '09:00',
    days: parseCronjobDays(row.schedule_days),
  }
  if (Number.isFinite(row.schedule_minutes) && row.schedule_minutes !== null) {
    schedule.intervalMinutes = Math.max(1, Math.floor(row.schedule_minutes))
    schedule.endTime = row.schedule_end_time ?? '23:59'
  }
  return schedule
}

function parseCronjobDays(daysRaw: string | null): number[] {
  if (!daysRaw) return []
  try {
    const value = JSON.parse(daysRaw) as unknown
    if (!Array.isArray(value)) return []
    const days = value
      .filter((day): day is number => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6)
      .sort((a, b) => a - b)
    return Array.from(new Set(days))
  } catch {
    return []
  }
}

function toCronjobResultStatus(value: string | null): CronjobRunResult['status'] | null {
  if (value === 'success' || value === 'error') return value
  return null
}

function toCronjobHistoryStatus(value: string): CronjobExecutionHistoryItem['status'] {
  if (value === 'success' || value === 'error' || value === 'unknown') return value
  return 'unknown'
}

function rowToCanvasWorkflow(row: Record<string, unknown>): CanvasWorkflow {
  return {
    id: row.id as number,
    name: row.name as string,
    description: (row.description as string) || undefined,
    workspaceId: (row.workspace_id as number) || undefined,
    nodes: JSON.parse(row.nodes as string),
    edges: JSON.parse(row.edges as string),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  }
}

function serializeMetadata(metadata: Record<string, unknown> | null | undefined): string | null {
  if (metadata == null) return null
  if (Object.keys(metadata).length === 0) return null
  return JSON.stringify(metadata)
}

function parseMetadata(value: unknown): Record<string, unknown> | null {
  if (value == null) return null
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}
