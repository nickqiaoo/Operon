// Client mirror of server/src/types/task.ts (project-level "local Linear" tasks).
// Kept in sync by hand — the server is the source of truth.

import type { BindingStatus } from './channel'

export type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled'

/** A subtask surfaced by POST /tasks/:id/prepare, for per-subtask agent assignment in the dispatch dialog. */
export interface PreparedSubtask {
  id: number
  number: number
  title: string
  planAnchor: string | null
  claimedAcs: string[] | null
  assignedAgentId: number | null
}

/** 0 none · 1 low · 2 medium · 3 high · 4 urgent. Sort DESC = urgent first. */
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
  sourceMessageId: number | null
  branchName: string | null
  workspaceId: number | null
  bindingId: number | null
  /** SDD: governed by the spec-driven gates? */
  sddManaged: boolean
  /** SDD parent: the single agent allowed to write spec/plan; null if none. */
  specAuthorAgentId: number | null
  /** SDD child: anchor into the parent plan item; null for parents. */
  planAnchor: string | null
  /** SDD child: AC ids this task is responsible for; null for parents. */
  claimedAcs: string[] | null
  createdBy: TaskCreatedBy
  /** Archived-at timestamp (ms); null = active. Archived tasks are hidden from the board by default. */
  archivedAt: number | null
  createdAt: number
  updatedAt: number
}

export type ArtifactKind = 'spec' | 'plan' | 'acceptance' | 'spec_delta'
export type ArtifactStatus = 'draft' | 'approved'

/** SDD artifact gate-state (canonical content lives in the change-branch file at contentRef). */
export interface TaskArtifact {
  id: number
  taskId: number
  kind: ArtifactKind
  status: ArtifactStatus
  approvedByType: 'human' | 'agent' | null
  approvedBy: number | null
  approvedAt: number | null
  contentRef: string | null
  contentSha: string | null
  updatedAt: number
  /** Current file content, included by GET /sdd/tasks/:id/artifacts. */
  content?: string | null
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
  | 'verify' // SDD: analyze / acceptance results
  | 'gate' // SDD: a gate blocked or was signed
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

export interface TaskListItem extends Task {
  labels: TaskLabel[]
}

export interface TaskDetail extends Task {
  labels: TaskLabel[]
  activity: TaskActivity[]
  team: Team | null
  children: TaskListItem[]
  /** Status of the task's own execution session (null if never dispatched). */
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
  sourceMessageId?: number | null
  labelIds?: number[]
  createdBy?: TaskCreatedBy
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
  labelIds?: number[]
}

export interface CreateTaskLabelInput {
  projectId: number
  name: string
  color?: string
  isTeam?: boolean
}

// ---- UI metadata ----

export const TASK_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done', 'cancelled']

export const TASK_PRIORITIES: TaskPriority[] = [0, 1, 2, 3, 4]

// Display labels for status/priority are i18n message descriptors — see
// `components/task/task-i18n.ts` (STATUS_MESSAGES / priorityMessage).

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
