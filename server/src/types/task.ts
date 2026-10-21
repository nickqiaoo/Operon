// Project-level first-class tasks ("local Linear").
// Project-level tasks live on the project, carry description/priority/labels,
// and own an activity feed.

import type { BindingStatus } from './agent-binding.js'
import type { SpecProgress, SpecStage, SpecTicketState } from './spec.js'

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
  sourceChannelId: number | null
  /** Started from a direct workspace chat (chats.id) — a spec reports back there; mutually exclusive with sourceChannelId. */
  sourceChatId: number | null
  sourceMessageId: number | null
  branchName: string | null
  workspaceId: number | null
  bindingId: number | null
  /** OperonSpec parent: where the spec stands (from spec_runs); null for every other task. */
  specStage: SpecStage | null
  /** OperonSpec ticket: sibling task ids that must finish before this one can start. */
  blockedBy: number[] | null
  /** OperonSpec parent from gate 1 on: tickets merged / total / blocked. */
  specProgress?: SpecProgress | null
  /** OperonSpec ticket: where it stands in its spec's build. */
  ticketState?: SpecTicketState | null
  createdBy: TaskCreatedBy
  /** Archived-at timestamp (ms); null = active. Archived tasks drop out of the default board view. */
  archivedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface TaskLabel {
  id: number
  projectId: number
  name: string
  color: string
  createdAt: number
}

export type TaskActivityKind =
  | 'comment'
  | 'status'
  | 'assign'
  | 'dispatch'
  | 'branch'
  | 'system'
  // SDD v2 verifier results and gate events — old rows only, nothing writes them now.
  | 'verify'
  | 'gate'
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

/**
 * Where the same task is visible outside operon (docs/linear-github/design.md §7).
 * The task is the truth; a surface is a Linear issue, the Linear agent session
 * running on it, or the GitHub pull request opened for it.
 */
export type TaskSurfaceKind = 'linear_issue' | 'linear_session' | 'github_pr'

export interface TaskSurface {
  id: number
  taskId: number
  kind: TaskSurfaceKind
  /** issue id | agent session id | owner/name#number */
  externalId: string
  url: string | null
  meta: Record<string, unknown> | null
  createdAt: number
}

export interface TaskSurfaceInput {
  taskId: number
  kind: TaskSurfaceKind
  externalId: string
  url?: string | null
  meta?: Record<string, unknown> | null
}

/** A question / approval the agent posted to a surface and is waiting on. */
export interface SurfacePending {
  approvalId: string
  taskId: number
  chatId: number
  surfaceKind: 'linear_session' | 'github_pr'
  surfaceRef: string
  toolName: string
  input: Record<string, unknown>
  createdAt: number
}

/** Task plus labels, sub-tasks, and full activity feed — detail page shape. */
export interface TaskDetail extends Task {
  labels: TaskLabel[]
  activity: TaskActivity[]
  children: TaskListItem[]
  /** External surfaces (Linear issue / session, GitHub PR); empty when none. */
  surfaces: TaskSurface[]
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
  sourceChannelId?: number | null
  sourceChatId?: number | null
  sourceMessageId?: number | null
  labelIds?: number[]
  createdBy?: TaskCreatedBy
  /** OperonSpec ticket: sibling task ids that must finish first. */
  blockedBy?: number[] | null
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
  branchName?: string | null
  workspaceId?: number | null
  bindingId?: number | null
  labelIds?: number[]
}

export interface ListTasksQuery {
  /** Omit for every project's tasks (the global board). */
  projectId?: number
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
