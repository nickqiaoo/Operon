// Sub-tasks a task's agent hands to other agents, from the board.
//
//   comment "give X to @a, Y to @b"  →  the task's agent calls propose_subtasks
//   → a proposal row in the task's activity, the task waits on the person (needs_input)
//   → the person picks an agent and a workspace for every item and confirms
//   → each item becomes a sub-task, dispatched where the person said
//   → the parent's agent is told what started, and again as each sub-task lands
//
// The agent never creates or dispatches these itself: where work runs (its own
// worktree, or a workspace shared with the person) is the person's call, made on
// the proposal card, so it cannot be guessed past in a prompt.

import type {
  ChannelStorageAdapter,
  NotificationStorageAdapter,
  TaskStorageAdapter,
} from '../storage/interface.js'
import type {
  SubtaskProposalItem,
  SubtaskProposalMeta,
  Task,
  TaskActivity,
  TaskStatus,
  TaskWorkspaceMode,
} from '../types/task.js'
import { dispatchProjectTask, wakeTaskBinding } from './channel/agent-orchestrator.js'
import { notifyTaskStatusChange } from './notification-service.js'
import { broadcastTask } from './task-events.js'

type Storage = TaskStorageAdapter & ChannelStorageAdapter & NotificationStorageAdapter

export const MAX_PROPOSAL_ITEMS = 10
const PROPOSAL_EVENT = 'subtasks.proposed'

export class SubtaskProposalError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message)
  }
}

export function isSubtaskProposal(activity: Pick<TaskActivity, 'kind' | 'meta'>): boolean {
  return activity.kind === 'system' && activity.meta?.event === PROPOSAL_EVENT
}

function proposalMeta(activity: TaskActivity): SubtaskProposalMeta | null {
  if (!isSubtaskProposal(activity)) return null
  const meta = activity.meta as Partial<SubtaskProposalMeta>
  if (!Array.isArray(meta.items)) return null
  return { event: PROPOSAL_EVENT, state: meta.state ?? 'pending', items: meta.items, resolvedAt: meta.resolvedAt }
}

const isSpecTicketOrSpec = (storage: Storage, task: Task): boolean => {
  if (task.specStage != null) return true
  const parent = task.parentTaskId != null ? storage.taskGet(task.parentTaskId) : null
  return parent?.specStage != null
}

const workspaceLabel = (mode: TaskWorkspaceMode) => (mode === 'shared' ? 'shared workspace' : 'new worktree')

// ---------------------------------------------------------------------------
// Propose (the task's agent)
// ---------------------------------------------------------------------------

export interface ProposedItemInput {
  title: string
  description: string
  assignee?: string
  workspace?: TaskWorkspaceMode
}

export function proposeSubtasks(
  storage: Storage,
  task: Task,
  agentId: number,
  agentName: string,
  input: ProposedItemInput[],
): { activity: TaskActivity; unknownAssignees: string[] } {
  if (task.assignedAgentId !== agentId) {
    throw new SubtaskProposalError(`Only task #${task.number}'s assignee can propose its sub-tasks.`, 409)
  }
  if (isSpecTicketOrSpec(storage, task)) {
    throw new SubtaskProposalError('A spec and its tickets are split by the spec itself, not by proposals.', 409)
  }
  const pending = storage.taskListActivity(task.id).find((a) => proposalMeta(a)?.state === 'pending')
  if (pending) {
    throw new SubtaskProposalError(
      `Task #${task.number} already has a proposal waiting for the user; wait for it to be confirmed or dismissed.`,
      409,
    )
  }
  const items = input.filter((i) => i.title.trim())
  if (items.length === 0) throw new SubtaskProposalError('Propose at least one sub-task with a title.')
  if (items.length > MAX_PROPOSAL_ITEMS) throw new SubtaskProposalError(`Propose at most ${MAX_PROPOSAL_ITEMS} sub-tasks at a time.`)

  const unknownAssignees: string[] = []
  const proposed: SubtaskProposalItem[] = items.map((item) => {
    const name = item.assignee?.trim().replace(/^@/, '')
    const agent = name ? storage.getAgentByName(name) : null
    if (name && !agent) unknownAssignees.push(name)
    return {
      title: item.title.trim(),
      description: item.description.trim(),
      assignedAgentId: agent?.id ?? null,
      workspaceMode: item.workspace ?? null,
    }
  })
  const meta: SubtaskProposalMeta = { event: PROPOSAL_EVENT, state: 'pending', items: proposed }
  const activity = storage.taskAppendActivity(task.id, {
    kind: 'system',
    actorType: 'agent',
    actorId: agentId,
    actorName: agentName,
    body: `proposed ${proposed.length} sub-task${proposed.length > 1 ? 's' : ''}`,
    meta: { ...meta },
  })
  // The proposal waits on the person. An agent-set needs_input goes back to work
  // when its session wakes, which confirming or dismissing does.
  if (task.status === 'in_progress') {
    storage.taskUpdate(task.id, { status: 'needs_input' }, { type: 'agent', id: agentId, name: agentName })
    notifyTaskStatusChange(storage, task, 'needs_input', task.status)
  }
  broadcastTask(storage, task.id)
  return { activity, unknownAssignees }
}

// ---------------------------------------------------------------------------
// Confirm / dismiss (the person)
// ---------------------------------------------------------------------------

export interface ConfirmedItemInput {
  title: string
  description: string
  assignedAgentId: number
  workspaceMode: TaskWorkspaceMode
}

function requirePending(storage: Storage, task: Task, activityId: number): SubtaskProposalMeta {
  const activity = storage.taskGetActivity(task.id, activityId)
  const meta = activity ? proposalMeta(activity) : null
  if (!meta) throw new SubtaskProposalError('Proposal not found', 404)
  if (meta.state !== 'pending') throw new SubtaskProposalError(`This proposal was already ${meta.state}`, 409)
  return meta
}

export async function confirmSubtaskProposal(
  storage: Storage,
  task: Task,
  activityId: number,
  input: ConfirmedItemInput[],
  actorName: string,
): Promise<SubtaskProposalItem[]> {
  const meta = requirePending(storage, task, activityId)
  if (input.length === 0) throw new SubtaskProposalError('Keep at least one sub-task, or dismiss the proposal.')
  if (input.length > MAX_PROPOSAL_ITEMS) throw new SubtaskProposalError(`At most ${MAX_PROPOSAL_ITEMS} sub-tasks.`)
  for (const item of input) {
    if (!item.title.trim()) throw new SubtaskProposalError('Every sub-task needs a title.')
    if (!storage.getAgent(item.assignedAgentId)) throw new SubtaskProposalError(`Agent ${item.assignedAgentId} not found`)
    if (item.workspaceMode !== 'new' && item.workspaceMode !== 'shared') {
      throw new SubtaskProposalError('Choose a workspace for every sub-task.')
    }
  }
  // Claimed before anything is created, so a double click cannot create the set twice.
  storage.taskUpdateActivityMeta(task.id, activityId, { ...meta, state: 'confirmed', resolvedAt: Date.now() })

  const proposer = storage.taskGetActivity(task.id, activityId)?.actorName ?? 'agent'
  const results: SubtaskProposalItem[] = []
  for (const item of input) {
    const child = storage.taskCreate({
      projectId: task.projectId,
      title: item.title.trim(),
      description: item.description.trim(),
      parentTaskId: task.id,
      assignedAgentId: item.assignedAgentId,
      workspaceMode: item.workspaceMode,
      createdBy: 'agent',
      actorName: proposer,
    })
    broadcastTask(storage, child.id)
    const result: SubtaskProposalItem = {
      title: child.title,
      description: child.description,
      assignedAgentId: item.assignedAgentId,
      workspaceMode: item.workspaceMode,
      taskId: child.id,
      taskNumber: child.number,
    }
    try {
      await dispatchProjectTask(child.id, item.assignedAgentId)
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err)
    }
    results.push(result)
  }
  storage.taskUpdateActivityMeta(task.id, activityId, { ...meta, state: 'confirmed', items: results, resolvedAt: Date.now() })
  storage.taskAppendActivity(task.id, {
    kind: 'system',
    actorType: 'human',
    actorName,
    body: `confirmed ${results.length} sub-task${results.length > 1 ? 's' : ''}`,
    meta: { event: 'subtasks.confirmed', proposalActivityId: activityId, count: results.length },
  })
  broadcastTask(storage, task.id)

  if (task.bindingId != null) {
    const lines = results.map((r) => {
      const agent = storage.getAgent(r.assignedAgentId ?? -1)?.name ?? 'agent'
      return r.error
        ? `- #${r.taskNumber} "${r.title}" → @${agent}: created but could not start (${r.error})`
        : `- #${r.taskNumber} "${r.title}" → @${agent}, ${workspaceLabel(r.workspaceMode ?? 'new')}`
    })
    void wakeTaskBinding(
      task.bindingId,
      `[The user confirmed your sub-task proposal on task #${task.number}]\n${lines.join('\n')}\n` +
        `Each runs in its own session. Don't do their work yourself; you will be told here as each one ` +
        `reaches review or finishes. Carry on with the rest of task #${task.number}, if any is left to you.`,
    ).catch((err) => console.warn(`[Subtasks] waking task #${task.number} failed:`, err))
  }
  return results
}

export function dismissSubtaskProposal(storage: Storage, task: Task, activityId: number, actorName: string): void {
  const meta = requirePending(storage, task, activityId)
  storage.taskUpdateActivityMeta(task.id, activityId, { ...meta, state: 'dismissed', resolvedAt: Date.now() })
  storage.taskAppendActivity(task.id, {
    kind: 'system',
    actorType: 'human',
    actorName,
    body: 'dismissed the sub-task proposal',
    meta: { event: 'subtasks.dismissed', proposalActivityId: activityId },
  })
  broadcastTask(storage, task.id)
  if (task.bindingId != null) {
    void wakeTaskBinding(
      task.bindingId,
      `[The user dismissed your sub-task proposal on task #${task.number}] Nothing was created. ` +
        `Read their latest comments with get_project_task(task: ${task.number}) for what they want instead.`,
    ).catch((err) => console.warn(`[Subtasks] waking task #${task.number} failed:`, err))
  }
}

// ---------------------------------------------------------------------------
// Reports back to the parent
// ---------------------------------------------------------------------------

const REPORTED: ReadonlySet<TaskStatus> = new Set(['in_review', 'done', 'cancelled'])

function lastAgentComment(storage: Storage, taskId: number): string | null {
  const activity = storage.taskListActivity(taskId)
  for (let i = activity.length - 1; i >= 0; i--) {
    const row = activity[i]
    if (row.kind === 'comment' && row.actorType === 'agent' && row.body.trim()) return row.body.trim()
  }
  return null
}

/** The latest status change was a person's (from the board, or a merged PR). */
function changedByHuman(storage: Storage, taskId: number): boolean {
  const activity = storage.taskListActivity(taskId)
  for (let i = activity.length - 1; i >= 0; i--) {
    if (activity[i].kind === 'status') return activity[i].actorType === 'human'
  }
  return false
}

/** A sub-task reached review, finished or was dropped: tell its parent's agent. */
export function reportSubtaskStatus(storage: Storage, before: Task, after: Task): void {
  if (after.parentTaskId == null || before.status === after.status || !REPORTED.has(after.status)) return
  const parent = storage.taskGet(after.parentTaskId)
  if (!parent || parent.specStage != null || parent.archivedAt != null) return
  if (parent.status === 'done' || parent.status === 'cancelled') return
  const agent = after.assignedAgentId != null ? storage.getAgent(after.assignedAgentId)?.name : null
  storage.taskAppendActivity(parent.id, {
    kind: 'system',
    actorType: 'system',
    actorName: 'system',
    body: `sub-task #${after.number} moved to ${after.status}`,
    meta: { event: 'subtask.status', subtaskId: after.id, subtaskNumber: after.number, from: before.status, to: after.status },
  })
  broadcastTask(storage, parent.id)
  // A person who marked it done (or dropped it) already knows; the agent hears of it when it next reads the task.
  if (parent.bindingId == null || changedByHuman(storage, after.id)) return
  const report = lastAgentComment(storage, after.id)
  const clipped = report && report.length > 1500 ? `${report.slice(0, 1500)}…` : report
  const open = storage
    .taskListChildren(parent.id)
    .filter((c) => c.id !== after.id && c.status !== 'done' && c.status !== 'cancelled')
  void wakeTaskBinding(
    parent.bindingId,
    `[Sub-task #${after.number} "${after.title}"${agent ? ` (@${agent})` : ''} is now ${after.status}]` +
      (clipped ? `\nIts latest report:\n${clipped}` : '') +
      `\n${open.length > 0 ? `Still open: ${open.map((c) => `#${c.number} (${c.status})`).join(', ')}.` : 'All sub-tasks are settled.'} ` +
      `Read it with get_project_task(task: ${after.number}). Tell the user on task #${parent.number} with ` +
      `comment_project_task what matters — do not review or redo the sub-task's work unless they ask.`,
  ).catch((err) => console.warn(`[Subtasks] waking task #${parent.number} failed:`, err))
}

let stopReports: (() => void) | null = null

export function initSubtaskReports(storage: Storage): void {
  stopReports?.()
  stopReports = storage.onTaskChange((before, after) => {
    try {
      reportSubtaskStatus(storage, before, after)
    } catch (err) {
      console.error('[Subtasks] report failed:', err)
    }
  })
}
