// Client mirror of server/src/types/task.ts (project-level "local Linear" tasks).
// Kept in sync by hand — the server is the source of truth.

import type { BindingStatus } from './channel'

import type { SpecProgress, SpecStage, SpecTicketState } from '@shared/spec'

export type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled'

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
  sourceChannelId: number | null
  sourceMessageId: number | null
  branchName: string | null
  workspaceId: number | null
  bindingId: number | null
  /** OperonSpec parent: where the spec stands; null for every other task. */
  specStage: SpecStage | null
  /** OperonSpec ticket: sibling task ids that must finish before this one can start. */
  blockedBy: number[] | null
  /** OperonSpec parent from gate 1 on: tickets merged / total / blocked. */
  specProgress?: SpecProgress | null
  /** OperonSpec ticket: where it stands in its spec's build. */
  ticketState?: SpecTicketState | null
  createdBy: TaskCreatedBy
  /** Archived-at timestamp (ms); null = active. Archived tasks are hidden from the board by default. */
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

export interface TaskListItem extends Task {
  labels: TaskLabel[]
}

export type TaskSurfaceKind = 'linear_issue' | 'linear_session' | 'github_pr'

/** Where the task is also visible outside operon: Linear issue / session, GitHub PR. */
export interface TaskSurface {
  id: number
  taskId: number
  kind: TaskSurfaceKind
  externalId: string
  url: string | null
  meta: Record<string, unknown> | null
  createdAt: number
}

export interface TaskDetail extends Task {
  labels: TaskLabel[]
  activity: TaskActivity[]
  children: TaskListItem[]
  surfaces: TaskSurface[]
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
  branchName?: string | null
  workspaceId?: number | null
  bindingId?: number | null
  labelIds?: number[]
}

export interface CreateTaskLabelInput {
  projectId: number
  name: string
  color?: string
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
