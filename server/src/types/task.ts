// Project-level first-class tasks ("local Linear").
// Project-level tasks live on the project, carry description/priority/labels,
// and own an activity feed.

import type { BindingStatus } from './agent-binding.js'

export type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled'

/** 0 none · 1 low · 2 medium · 3 high · 4 urgent. ORDER BY priority DESC = urgent first. */
export type TaskPriority = 0 | 1 | 2 | 3 | 4

export type TaskCreatedBy = 'human' | 'agent'

export interface Task {
  id: number
  projectId: number
  number: number
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  assignedAgentId: number | null
  parentTaskId: number | null
  teamId: number | null
  sourceChannelId: number | null
  /** SDD: promoted from a direct workspace chat (chats.id); mutually exclusive with sourceChannelId. */
  sourceChatId: number | null
  sourceMessageId: number | null
  branchName: string | null
  workspaceId: number | null
  bindingId: number | null
  /** SDD: is this task governed by the spec-driven gates? (§9) */
  sddManaged: boolean
  /** SDD parent: the recorded spec author (§5.4, ownership lock removed — others may write but get a soft-warn); null if none. */
  specAuthorAgentId: number | null
  /** SDD child: anchor into the parent plan.md item this task implements (e.g. 'T1'); null for parents. */
  planAnchor: string | null
  /** SDD child: AC ids this task is responsible for (e.g. ['AC-1','AC-2']); null for parents. */
  claimedAcs: string[] | null
  createdBy: TaskCreatedBy
  /** Archived-at timestamp (ms); null = active. Archived tasks drop out of the default board view. */
  archivedAt: number | null
  createdAt: number
  updatedAt: number
}

export type ArtifactKind = 'spec' | 'plan' | 'acceptance' | 'spec_delta'
export type ArtifactStatus = 'draft' | 'approved'

/**
 * SDD artifact gate-state row. The canonical markdown lives in the change-branch file
 * at `contentRef` (§5) — this row carries only the gate status + pointer + sha.
 */
export interface TaskArtifact {
  id: number
  taskId: number
  kind: ArtifactKind
  status: ArtifactStatus
  /** Who signed it: 'human' | 'agent'; null = unsigned. */
  approvedByType: 'human' | 'agent' | null
  approvedBy: number | null
  approvedAt: number | null
  /** Path on the change branch; null before materialization. */
  contentRef: string | null
  /** git blob sha at approval, for drift detection. */
  contentSha: string | null
  updatedAt: number
}

/** Partial upsert for a task artifact row. Only provided fields are written. */
export interface UpsertArtifactInput {
  status?: ArtifactStatus
  approvedByType?: 'human' | 'agent' | null
  approvedBy?: number | null
  approvedAt?: number | null
  contentRef?: string | null
  contentSha?: string | null
}

export interface Team {
  id: number
  projectId: number
  name: string
  color: string
  createdAt: number
}

export interface CreateTeamInput {
  projectId: number
  name: string
  color?: string
}

export interface UpdateTeamInput {
  name?: string
  color?: string
}

export interface TaskLabel {
  id: number
  projectId: number
  name: string
  color: string
  isTeam: boolean
  createdAt: number
}

export type TaskActivityKind =
  | 'comment'
  | 'status'
  | 'assign'
  | 'dispatch'
  | 'branch'
  | 'system'
  | 'verify' // SDD: analyze / acceptance results (§10)
  | 'gate' // SDD: a gate blocked or was signed (§10)
export type TaskActorType = 'human' | 'agent' | 'system'

export interface TaskActivity {
  id: number
  taskId: number
  kind: TaskActivityKind
  actorType: TaskActorType
  actorId: number | null
  actorName: string
  body: string
  meta: Record<string, unknown> | null
  createdAt: number
}

/** Task plus its labels — list/board row shape. */
export interface TaskListItem extends Task {
  labels: TaskLabel[]
}

/** Task plus labels, team, sub-tasks, and full activity feed — detail page shape. */
export interface TaskDetail extends Task {
  labels: TaskLabel[]
  activity: TaskActivity[]
  team: Team | null
  children: TaskListItem[]
  /**
   * Status of the task's own execution binding (the agent session running IN
   * the task worktree), or null if it was never dispatched. Distinct from any
   * channel session of the same agent — the UI uses this to decide whether the
   * task is actually running and whether to offer Dispatch.
   */
  executionStatus?: BindingStatus | null
}

export interface CreateTaskInput {
  projectId: number
  title: string
  description?: string
  priority?: TaskPriority
  assignedAgentId?: number | null
  parentTaskId?: number | null
  teamId?: number | null
  sourceChannelId?: number | null
  sourceChatId?: number | null
  sourceMessageId?: number | null
  labelIds?: number[]
  createdBy?: TaskCreatedBy
  /** SDD fields (§4/§9). Set by create_spec_task for parents; child fields set when decomposing a plan. */
  sddManaged?: boolean
  specAuthorAgentId?: number | null
  planAnchor?: string | null
  claimedAcs?: string[] | null
  /** Actor recorded on the auto-created "created this task" activity row. */
  actorId?: number | null
  actorName?: string
}

export interface UpdateTaskInput {
  title?: string
  description?: string
  status?: TaskStatus
  priority?: TaskPriority
  assignedAgentId?: number | null
  parentTaskId?: number | null
  teamId?: number | null
  branchName?: string | null
  workspaceId?: number | null
  bindingId?: number | null
  /** SDD: reassign the spec/plan single-writer (human owner may change this anytime; §5.4). */
  specAuthorAgentId?: number | null
  labelIds?: number[]
}

export interface ListTasksQuery {
  projectId: number
  status?: TaskStatus
  assignedAgentId?: number
  labelId?: number
  priority?: TaskPriority
  /** Include archived tasks. Default false — archived tasks are hidden from the board and list_project_tasks. */
  includeArchived?: boolean
}

export interface TaskActivityInput {
  kind: TaskActivityKind
  actorType: TaskActorType
  actorId?: number | null
  actorName: string
  body?: string
  meta?: Record<string, unknown> | null
}

export interface CreateTaskLabelInput {
  projectId: number
  name: string
  color?: string
  isTeam?: boolean
}

/** Actor performing a mutation — used to attribute auto-logged activity. */
export interface TaskActor {
  type: TaskActorType
  id?: number | null
  name: string
}

/**
 * Allowed status transitions (status is the single source of truth; certain
 * transitions carry side effects — entering in_progress dispatches, etc.).
 * `from === to` is always allowed (idempotent no-op).
 */
const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ['in_progress', 'cancelled'],
  in_progress: ['in_review', 'done', 'todo', 'cancelled'],
  in_review: ['done', 'in_progress', 'cancelled'],
  done: ['todo', 'in_progress'],
  cancelled: ['todo'],
}

export function isValidTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true
  return TASK_TRANSITIONS[from]?.includes(to) ?? false
}
