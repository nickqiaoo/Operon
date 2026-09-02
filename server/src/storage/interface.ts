import type { ChatHistoryEntry, ChatHistoryListItem, ChatHistoryPatchInput, ChatHistoryPatchResult, ChatMeta } from '../types/chat.js'
import type { CronjobExecutionHistoryItem, CronjobTask } from '../types/cronjob.js'
import type {
  ChatExtractionCandidate,
  CreateMemoryMaintenanceRunInput,
  MemoryMaintenanceConfig,
  MemoryMaintenanceRun,
  UpdateMemoryMaintenanceRunInput,
} from '../types/memory-maintenance.js'
import type {
  CanvasWorkflow,
  CanvasWorkflowListItem,
  CanvasWorkflowRun,
  CreateCanvasWorkflowInput,
  UpdateCanvasWorkflowInput,
  NodeResult,
  NodeResultUpdate,
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
  UnreadCounts,
} from '../types/notification.js'
import type {
  AgentBinding,
  AgentInboxMessageRow,
  AgentMessageCursor,
  CreateAgentInboxMessageInput,
  CursorStreamKind,
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
  CreateIMMessageInput,
  CreateIMProviderInput,
  IMInsertResult,
  IMInteractiveChat,
  IMMessageRow,
  IMProviderRecord,
  IMSource,
  UpdateIMProviderInput,
  UpsertIMInteractiveChatInput,
} from '../types/im.js'

export interface StorageAdapter {
  get<T = unknown>(key: string): T | undefined
  set<T = unknown>(key: string, value: T): void
  delete(key: string): void
  getAll<T = unknown>(): T | undefined
  setAll<T = unknown>(data: T): void
  /** Return all keys, optionally filtered by prefix */
  keys(prefix?: string): string[]
}

export interface ListChatEntriesQuery {
  workspaceId?: number
  tp?: string
  /** Max rows to return. Omitted → every chat in the workspace (legacy behaviour). */
  limit?: number
  /** Rows to skip, for "load more" paging over the `updated_at DESC` order. */
  offset?: number
}

export interface ChatStorageAdapter {
  getChatEntry(chatId: number): ChatHistoryEntry | undefined
  /** Paginated message query — returns messages and hasMore flag */
  getChatMessages(chatId: number, opts?: { before?: number; limit?: number }): { messages: unknown[]; total: number; hasMore: boolean; nextCursor?: number } | undefined
  /** Lightweight metadata query — no messages loaded */
  getChatMeta(chatId: number): ChatMeta | undefined
  patchChatEntry(chatId: number | null, input: ChatHistoryPatchInput): ChatHistoryPatchResult
  deleteChatEntry(chatId: number): void
  listChatEntries(query?: ListChatEntriesQuery): ChatHistoryListItem[]
  /** Update only the session_id column without changing revision or messages */
  updateChatSessionId(chatId: number, sessionId: string): void
  /** The chat whose provider session is `sessionId`, if any (chats.session_id is unique per session). */
  findChatBySessionId(sessionId: string): (ChatMeta & { id: number }) | undefined
  /** Update only the metadata JSON column without changing revision or messages */
  updateChatMetadata(chatId: number, metadata: import('../types/chat.js').ChatMetadata): void
  // --- Workflow: one append-only event log + a rebuildable index (0038) ---
  /**
   * Append events atomically, in the given order. Returns the id of the last
   * row written — the cursor a live feed resumes from.
   */
  appendWorkflowEvents(rows: WorkflowEventInput[]): number
  /**
   * One run's events in log order. `sinceId` tails; `excludeKinds` skips the
   * high-volume `chunk` rows when only the run view is wanted.
   */
  readWorkflowEvents(runId: string, opts?: WorkflowEventQuery): WorkflowEventRow[]
  /** Events for several runs at once (the panel list folds all of them in one read). */
  readWorkflowEventsForRuns(runIds: string[], opts?: WorkflowEventQuery): WorkflowEventRow[]
  /** Global tail across every run — the panel's single live feed. */
  readWorkflowEventsSince(sinceId: number, opts?: { excludeKinds?: string[]; limit?: number }): WorkflowEventRow[]
  /** Highest event id written so far (0 when the log is empty). */
  lastWorkflowEventId(): number
  /** Upsert the derived index row for a run. */
  upsertWorkflowRunIndex(row: WorkflowRunIndexRow): void
  /** Recent runs, newest first — index only; the view is folded from events. */
  listWorkflowRunIndex(limit?: number): WorkflowRunIndexRow[]
  getWorkflowRunIndex(runId: string): WorkflowRunIndexRow | undefined
  /** Run ids still marked `running` — the startup sweep settles these as interrupted. */
  listRunningWorkflowRunIds(): string[]
  /**
   * Retention: drop every run beyond the newest `keep`, from BOTH tables. The
   * single place workflow data is deleted, because it is the single place it is
   * stored. Returns how many runs were removed.
   */
  pruneWorkflowRuns(keep: number): number
}

/** An event on its way into the log. */
export interface WorkflowEventInput {
  runId: string
  ts: number
  kind: string
  /** JSON of the WorkflowEvent payload. */
  data: string
}

/** A persisted event row. */
export interface WorkflowEventRow extends WorkflowEventInput {
  id: number
}

export interface WorkflowEventQuery {
  sinceId?: number
  excludeKinds?: string[]
  kinds?: string[]
  limit?: number
}

/**
 * The derived run index (0038). Every column here is also recoverable from the
 * event log; this table exists so the panel can order and page without folding.
 */
export interface WorkflowRunIndexRow {
  runId: string
  chatId: number | null
  name: string
  status: string
  startedAt: number
  endedAt: number | null
}

export interface CronjobStorageAdapter {
  listCronjobs(): CronjobTask[]
  getCronjobById(id: number): CronjobTask | undefined
  upsertCronjob(job: CronjobTask): void
  deleteCronjobById(id: number): boolean
  listCronjobRuns(jobId: number): CronjobExecutionHistoryItem[]
  addCronjobRun(entry: CronjobExecutionHistoryItem): void
}

export interface ChatMessageRow {
  messageIndex: number
  payload: unknown
}

export interface MemoryMaintenanceStorageAdapter {
  getMemoryMaintenanceConfig(): MemoryMaintenanceConfig
  updateMemoryMaintenanceConfig(updates: Partial<Omit<MemoryMaintenanceConfig, 'updatedAt'>>): MemoryMaintenanceConfig
  listMemoryMaintenanceCandidates(opts: { olderThanMs: number; newerThanMs?: number; limit: number }): ChatExtractionCandidate[]
  getChatMessagesWithIndex(chatId: number, opts: { afterIndex: number | null; limit?: number }): ChatMessageRow[]
  setChatLastExtractedMessageIndex(chatId: number, messageIndex: number): void
  createMemoryMaintenanceRun(input: CreateMemoryMaintenanceRunInput): MemoryMaintenanceRun
  updateMemoryMaintenanceRun(id: number, updates: UpdateMemoryMaintenanceRunInput): void
  listMemoryMaintenanceRuns(limit?: number): MemoryMaintenanceRun[]
}

export interface CheckpointRecord {
  /** Snapshot taken before the turn ran — the rewind target and diff base. */
  snapshotId: string
  /**
   * Snapshot taken once the turn finished, closing the turn's diff interval.
   * Undefined for rows written before the end-snapshot migration and for turns
   * whose end capture failed (e.g. the process died mid-turn).
   */
  endSnapshotId?: string
  /**
   * Another chat wrote to the same workspace while this turn ran, so the
   * [start, end] interval may contain changes this chat did not make. Rewind
   * asks before reverting those files instead of claiming them.
   */
  overlapped?: boolean
  createdAt: number
}

export interface CheckpointStorageAdapter {
  saveCheckpoint(chatId: number, messageUid: string, entry: CheckpointRecord): void
  /** Attach the closing snapshot and overlap verdict, leaving the rest intact. */
  setCheckpointEnd(chatId: number, messageUid: string, endSnapshotId: string, overlapped?: boolean): void
  getCheckpoint(chatId: number, messageUid: string): CheckpointRecord | undefined
  listCheckpoints(chatId: number): Record<string, CheckpointRecord>
  removeCheckpoints(chatId: number): void
  /**
   * Keep only the most recent `keep` checkpoints for a chat; delete the rest.
   * Returns the message uids of the deleted (evicted) checkpoints.
   */
  pruneCheckpoints(chatId: number, keep: number): string[]
}

export interface CanvasWorkflowStorageAdapter {
  // Workflow CRUD
  createCanvasWorkflow(input: CreateCanvasWorkflowInput): CanvasWorkflow
  getCanvasWorkflow(id: number): CanvasWorkflow | null
  /** Returns each workflow with its last run folded in — see CanvasWorkflowListItem. */
  listCanvasWorkflows(workspaceId?: number): CanvasWorkflowListItem[]
  updateCanvasWorkflow(id: number, updates: UpdateCanvasWorkflowInput): void
  deleteCanvasWorkflow(id: number): void

  // Run Management
  createCanvasRun(workflowId: number): number
  updateCanvasRunStatus(runId: number, status: 'success' | 'error', data?: { outputs?: Record<string, string>; error?: string }): void
  getCanvasRun(runId: number): CanvasWorkflowRun | null
  listCanvasRuns(workflowId: number, limit?: number): CanvasWorkflowRun[]

  // Node Results
  updateCanvasNodeResult(runId: number, nodeId: string, result: NodeResultUpdate): void
  getCanvasNodeResults(runId: number): NodeResult[]
}

export interface ProjectStorageAdapter {
  // Projects
  createProject(input: CreateProjectInput): Project
  getProject(id: number): Project | null
  listProjects(): Project[]
  deleteProject(id: number): void

  // Workspaces
  createWorkspace(projectId: number, input: CreateWorkspaceInput): Workspace
  getWorkspace(id: number): Workspace | null
  listWorkspaces(projectId: number): Workspace[]
  deleteWorkspace(id: number): void
}

export interface ChannelStorageAdapter {
  // Agent CRUD
  createAgent(input: CreateAgentInput): Agent
  getAgent(id: number): Agent | null
  getAgentByName(name: string): Agent | null
  listAgents(): Agent[]
  updateAgent(id: number, updates: UpdateAgentInput): void
  deleteAgent(id: number): void

  // Channel CRUD
  createChannel(input: CreateChannelInput): Channel
  getChannel(id: number): Channel | null
  listChannels(projectId: number): Channel[]
  deleteChannel(id: number): void
  /** Toggle the per-channel SDD master switch (§9). Returns the updated channel, or null if absent. */

  // Members
  addMember(channelId: number, agentId: number): ChannelMember
  removeMember(channelId: number, agentId: number): void
  listMembers(channelId: number): ChannelMember[]

  // Messages
  createMessage(input: CreateMessageInput): ChannelMessage
  listMessages(channelId: number, opts?: { before?: number; limit?: number }): { messages: ChannelMessage[]; hasMore: boolean }
  listThreadReplies(threadRootId: number): ChannelMessage[]

  // Channel-message unread (cursor lives in agent_message_cursors via AgentBindingStorageAdapter)
  getUnreadChannelMessages(agentId: number, channelId: number): ChannelMessage[]
}

/**
 * Project-level first-class tasks ("local Linear"). These are the only current
 * task APIs.
 */
export interface TaskStorageAdapter {
  taskCreate(input: CreateProjectTaskInput): Task
  taskGet(id: number): Task | null
  taskGetByNumber(projectId: number, number: number): Task | null
  /** Reverse of `tasks.workspace_id` — the task that owns a dispatched worktree. */
  taskGetByWorkspace(workspaceId: number): Task | null
  taskList(query: ListTasksQuery): TaskListItem[]
  taskDetail(id: number): TaskDetail | null
  taskUpdate(id: number, updates: UpdateProjectTaskInput, actor?: TaskActor): Task | null
  /** Archive (archived=true) or restore (false) a task. Logs a system activity row. */
  taskSetArchived(id: number, archived: boolean, actor?: TaskActor): Task | null

  // Activity feed (events + comments)
  taskAppendActivity(taskId: number, entry: TaskActivityInput): TaskActivity
  taskListActivity(taskId: number): TaskActivity[]

  // Labels
  taskListLabelDefs(projectId: number): TaskLabel[]
  taskCreateLabelDef(input: CreateTaskLabelInput): TaskLabel
  taskGetLabels(taskId: number): TaskLabel[]

  // Teams (first-class coordination scope; inbox keys on team_id)
  teamCreate(input: CreateTeamInput): Team
  teamUpdate(id: number, updates: UpdateTeamInput): Team | null
  teamDelete(id: number): boolean
  teamList(projectId: number): Team[]
  teamGet(id: number): Team | null
  taskListByTeam(teamId: number): Task[]
  taskListChildren(parentTaskId: number): Task[]

  // SDD artifacts (gate state + pointer to the change-branch file; §5/§10).
  // The canonical content lives in git, not here: these rows only carry status/ref/sha.
  taskArtifactGet(taskId: number, kind: ArtifactKind): TaskArtifact | null
  taskArtifactList(taskId: number): TaskArtifact[]
  taskArtifactUpsert(taskId: number, kind: ArtifactKind, input: UpsertArtifactInput): TaskArtifact
}

/**
 * User notification inbox — a cross-project attention feed. `notificationUpsert`
 * coalesces by `sourceKey` (one live row per chat/task) and re-unreads on a new
 * event; markRead accepts ids, source keys, or 'all'; archive accepts ids or
 * 'all'. See
 * the notification inbox.
 */
export interface NotificationStorageAdapter {
  notificationUpsert(input: NotifyInput): Notification
  notificationGet(id: number): Notification | null
  notificationList(query: ListNotificationsQuery): Notification[]
  /** Mark read; returns the ids that actually transitioned unread→read. */
  notificationMarkRead(ids: number[] | 'all'): number[]
  /** Mark the live row for `sourceKey` read. `kind` optionally protects a
   *  lifecycle-specific transition from consuming a newer row for that source. */
  notificationMarkReadBySource(sourceKey: string, kind?: NotificationKind): number[]
  /** Archive (dismiss); returns the ids that actually transitioned. */
  notificationArchive(ids: number[] | 'all'): number[]
  notificationUnreadCounts(): UnreadCounts
}

export interface IMStorageAdapter {
  // Providers
  createIMProvider(input: CreateIMProviderInput): IMProviderRecord
  getIMProvider(id: number): IMProviderRecord | null
  getIMProviderByInstance(source: IMSource, instanceId: string): IMProviderRecord | null
  listIMProviders(filter?: { source?: IMSource; enabled?: boolean }): IMProviderRecord[]
  updateIMProvider(id: number, updates: UpdateIMProviderInput): void
  deleteIMProvider(id: number): void

  // Messages (im_messages table — IM-only inbox; binding/cursor moved to AgentBindingStorageAdapter)
  //
  // Per-recipient model: each row is owned by exactly one recipient agent
  // (the agent whose mate bot delivered the webhook). Two bots in the same
  // group produce two rows, one per agent. Reads filter by recipient.
  insertIMMessage(input: CreateIMMessageInput): IMInsertResult
  getIMMessage(id: number): IMMessageRow | null
  /**
   * Look up by the native (per-bot) message id within a recipient agent's
   * inbox. Telegram's source_ts is per-bot so the recipient must be specified.
   */
  getIMMessageByNativeTs(
    recipientAgentId: number,
    source: IMSource,
    sourceChannel: string,
    sourceTs: string,
  ): IMMessageRow | null
  listIMMessages(
    source: IMSource,
    sourceChannel: string,
    opts?: { afterId?: number; beforeId?: number; limit?: number; recipientAgentId?: number }
  ): IMMessageRow[]
  /** Unread im_messages for an agent in a specific (source, channel). Reads cursor from agent_message_cursors. */
  getUnreadIMMessages(
    agentId: number,
    source: IMSource,
    sourceChannel: string,
    limit?: number
  ): IMMessageRow[]

  // Interactive chat routing (replaces the legacy `gateway` table)
  upsertIMInteractiveChat(input: UpsertIMInteractiveChatInput): IMInteractiveChat
  getIMInteractiveChat(source: IMSource, externalId: string): IMInteractiveChat | null
  getIMInteractiveChatByChatId(chatId: number): IMInteractiveChat | null
  deleteIMInteractiveChat(source: IMSource, externalId: string): void
  listIMInteractiveChatsBySource(source: IMSource): IMInteractiveChat[]
}

// ============================================================
// Unified agent binding + cursor + inbox storage
// ============================================================

export interface AgentBindingStorageAdapter {
  // Bindings
  upsertBinding(input: UpsertAgentBindingInput): AgentBinding
  updateBinding(id: number, updates: UpdateAgentBindingInput): void
  deleteBinding(id: number): void
  getBinding(id: number): AgentBinding | null
  /** Find a binding by its scope identity (e.g. lookup mate binding by source_channel+agent). */
  getBindingByScope(
    scopeKind: AgentBinding['scopeKind'],
    scopeKey: string,
    agentId: number,
  ): AgentBinding | null
  /** Reverse lookup by a binding's external session id. */
  getBindingByAgentSessionId(agentSessionId: string): AgentBinding | null
  /** Reverse lookup by chat id (used by orchestrators on stream end). */
  getBindingByActiveChatId(chatId: number): AgentBinding | null
  /** List bindings matching the query. Indexes cover (agent, status), (project, kind, status), (im_provider). */
  listBindings(query: ListBindingsQuery): AgentBinding[]
  /** Convenience: all bindings on a given scope (e.g. all agents on slack:C123). */
  listBindingsForScope(scopeKind: AgentBinding['scopeKind'], scopeKey: string): AgentBinding[]

  // Cursors (unified across channel / mate / inbox streams)
  getCursor(agentId: number, streamKind: CursorStreamKind, streamKey: string): AgentMessageCursor | null
  upsertCursor(
    agentId: number,
    streamKind: CursorStreamKind,
    streamKey: string,
    lastReadId: number,
  ): void

  // Inbox (agent-to-agent point-to-point messages)
  insertInboxMessage(input: CreateAgentInboxMessageInput): AgentInboxMessageRow
  getInboxMessage(id: number): AgentInboxMessageRow | null
  /** Unread inbox messages for an agent. Reads cursor from agent_message_cursors.
   *  When `scopeDisplayName` is provided, only returns messages whose `ref_id` matches
   *  it or is NULL (broadcast); cursor is keyed per scope so each session has
   *  its own read pointer. When omitted/null, falls back to legacy cross-session behavior. */
  getUnreadInboxMessages(
    agentId: number,
    opts?: { scopeDisplayName?: string | null; limit?: number },
  ): AgentInboxMessageRow[]
  /** History query for inbox_read_history tool. */
  listInboxMessages(
    agentId: number,
    opts?: { senderAgentId?: number; beforeId?: number; afterId?: number; limit?: number },
  ): AgentInboxMessageRow[]
}

export interface MobilePairingStorageAdapter {
  insertMobilePairing(input: CreateMobilePairingInput): MobilePairingRow
  getMobilePairingByNonce(pairingNonce: string): MobilePairingRow | null
  getMobilePairingByDevice(desktopId: string, mobileDeviceId: string): MobilePairingRow | null
  listMobilePairings(desktopId: string): MobilePairingRow[]
  confirmMobilePairing(pairingNonce: string, confirmedAt: number): MobilePairingRow | null
  setMobilePairingStatus(id: number, status: MobilePairingStatus, ts: number): void
  touchMobilePairingLastSeen(desktopId: string, mobileDeviceId: string, ts: number): void
}
