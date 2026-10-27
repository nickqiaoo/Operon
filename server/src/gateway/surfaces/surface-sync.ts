import type {
  ChannelStorageAdapter,
  NotificationStorageAdapter,
  ProjectStorageAdapter,
  TaskStorageAdapter,
} from '../../storage/interface.js'
import type { Task, TaskPriority, TaskStatus, TaskSurface } from '../../types/task.js'
import { isValidTaskTransition } from '../../types/task.js'
import { getLinearAppConfig, getLinearPublishTeam, rememberLinearPublishTeam } from '../../services/integration-config.js'
import {
  createLinearComment,
  createLinearIssue,
  fetchLinearTeamDetails,
  updateLinearIssue,
  type LinearWorkflowState,
} from '../../services/integrations/linear-app.js'
import { claimRoute } from '../../services/integrations/project-repos.js'
import { broadcastTask, registerTaskBroadcastListener } from '../../services/task-events.js'
import { notifyTaskStatusChange } from '../../services/notification-service.js'
import {
  completeTaskAfterHumanReview,
  maybeAutoDispatchTask,
  maybeAutoIntegrate,
} from '../../services/channel/agent-orchestrator.js'
import { announceToSurfaces } from './task-surface-bridge.js'
import { fromLinearPriority, pickLinearState, statusOfLinearState, toLinearPriority } from './linear-mapping.js'

export { fromLinearPriority, pickLinearState, statusOfLinearState, toLinearPriority }

// Task ⇄ Linear issue, both ways, for a fixed field set: status, title,
// description, priority, comments (docs/linear-github/design.md §11.2).
//
// Loop rule: every value written to Linear is remembered on the surface row
// (`meta.synced`). An inbound change whose new value equals what we last wrote
// is our own echo and is dropped; anything else is newer and lands on the task.
// Outbound, the task is diffed against the same snapshot after every broadcast.
//
// Subtasks are not a field: each one is published as a sub-issue of its
// parent's issue and then syncs on its own surface like any other task.
//
// Not in the set: the assignee (on Linear it is always the workspace agent; on
// operon it is an agent, not a person), agent-session activities,
// spec files.

type Storage = TaskStorageAdapter & ChannelStorageAdapter & ProjectStorageAdapter & NotificationStorageAdapter

interface SyncedSnapshot {
  status?: TaskStatus
  title?: string
  description?: string
  priority?: TaskPriority
}

let _storage: Storage | null = null
const stateCache = new Map<string, { states: LinearWorkflowState[]; expiresAt: number }>()
const inFlight = new Set<number>()
/** Comment ids we created on Linear: their webhooks are echoes. */
const mirroredCommentIds = new Set<string>()

export function initSurfaceSync(storage: Storage): void {
  _storage = storage
  registerTaskBroadcastListener((task) => {
    void onTaskBroadcast(task).catch((err) => {
      console.warn('[Surfaces] sync failed:', err instanceof Error ? err.message : err)
    })
  })
}

function storage(): Storage {
  if (!_storage) throw new Error('surface sync not initialised')
  return _storage
}

// ---- workflow states ----

async function teamStates(orgId: string, teamId: string): Promise<LinearWorkflowState[]> {
  const hit = stateCache.get(teamId)
  if (hit && hit.expiresAt > Date.now()) return hit.states
  const details = await fetchLinearTeamDetails(orgId, teamId)
  stateCache.set(teamId, { states: details.states, expiresAt: Date.now() + 10 * 60 * 1000 })
  return details.states
}

// ---- snapshot helpers ----

function issueSurface(taskId: number): TaskSurface | null {
  return storage().taskSurfaceList(taskId).find((s) => s.kind === 'linear_issue') ?? null
}

function snapshotOf(surface: TaskSurface): SyncedSnapshot {
  const meta = surface.meta ?? {}
  const synced = (meta.synced as SyncedSnapshot | undefined) ?? {}
  // Older rows only carried syncedStatus.
  if (!synced.status && typeof meta.syncedStatus === 'string') synced.status = meta.syncedStatus as TaskStatus
  return synced
}

function writeSnapshot(taskId: number, surface: TaskSurface, patch: SyncedSnapshot): void {
  const next = { ...snapshotOf(surface), ...patch }
  storage().taskSurfaceUpsert({
    taskId,
    kind: 'linear_issue',
    externalId: surface.externalId,
    meta: { synced: next, syncedStatus: next.status },
  })
}

function orgOf(surface: TaskSurface): string | undefined {
  return (surface.meta?.orgId as string | undefined) ?? getLinearAppConfig()?.orgId
}

// ---- outbound: task → Linear ----

async function onTaskBroadcast(task: Task): Promise<void> {
  const surface = issueSurface(task.id)
  if (!surface) {
    // A subtask follows its published parent onto Linear (e.g. tickets a
    // spec adds after the parent was published).
    if (task.parentTaskId != null && issueSurface(task.parentTaskId)) await publishSubtasks(task.parentTaskId)
    return
  }
  if (hasUnpublishedSubtasks(task.id)) {
    void publishSubtasks(task.id).catch((err) => {
      console.warn('[Surfaces] subtask publish failed:', err instanceof Error ? err.message : err)
    })
  }
  if (inFlight.has(task.id)) return
  const orgId = orgOf(surface)
  const teamId = surface.meta?.teamId as string | undefined
  if (!orgId) return
  const synced = snapshotOf(surface)
  const patch: { stateId?: string; title?: string; description?: string; priority?: number } = {}
  const written: SyncedSnapshot = {}
  if (task.title !== synced.title) {
    patch.title = task.title
    written.title = task.title
  }
  if ((task.description ?? '') !== (synced.description ?? '')) {
    patch.description = task.description ?? ''
    written.description = task.description ?? ''
  }
  if (task.priority !== synced.priority) {
    patch.priority = toLinearPriority(task.priority)
    written.priority = task.priority
  }
  if (task.status !== synced.status && teamId) {
    const state = pickLinearState(await teamStates(orgId, teamId), task.status)
    if (state) patch.stateId = state.id
    written.status = task.status
  }
  if (Object.keys(patch).length === 0) return
  inFlight.add(task.id)
  try {
    await updateLinearIssue(orgId, surface.externalId, patch)
    writeSnapshot(task.id, surface, written)
  } finally {
    inFlight.delete(task.id)
  }
}

// ---- inbound: Linear → task ----

export interface InboundIssueChange {
  issueId: string
  actorName: string
  title?: string
  description?: string
  priority?: number
  state?: { id: string; name: string; type: string }
  assigneeId?: string | null
  /** Field names Linear says changed (payload.updatedFrom keys); empty = unknown. */
  changed: string[]
}

/**
 * An Issue webhook. Fields Linear reports as changed are compared with what we
 * last wrote; matches are echoes, the rest is applied.
 */
export async function applyIssueChange(change: InboundIssueChange): Promise<void> {
  const st = storage()
  const surface = st.taskSurfaceFind('linear_issue', change.issueId)
  const task = surface ? st.taskGet(surface.taskId) : null
  if (!surface || !task) return
  const synced = snapshotOf(surface)
  const changed = new Set(change.changed)
  const has = (f: string) => changed.size === 0 || changed.has(f)
  const actor = { type: 'human' as const, name: change.actorName || 'Linear' }
  const patch: { title?: string; description?: string; priority?: TaskPriority } = {}
  const written: SyncedSnapshot = {}

  if (has('title') && change.title !== undefined && change.title !== synced.title && change.title !== task.title) {
    patch.title = change.title
    written.title = change.title
  }
  if (has('description') && change.description !== undefined) {
    const d = change.description ?? ''
    if (d !== (synced.description ?? '') && d !== (task.description ?? '')) {
      patch.description = d
      written.description = d
    }
  }
  if (has('priority') && change.priority !== undefined) {
    const p = fromLinearPriority(change.priority)
    if (p !== synced.priority && p !== task.priority) {
      patch.priority = p
      written.priority = p
    }
  }
  if (Object.keys(patch).length > 0) {
    st.taskUpdate(task.id, patch, actor)
    writeSnapshot(task.id, surface, written)
  }

  // Unassigned from the agent: the work leaves operon.
  const appUserId = getLinearAppConfig()?.appUserId
  if (has('assigneeId') && appUserId && change.assigneeId !== undefined && change.assigneeId !== appUserId) {
    if (task.status !== 'done' && task.status !== 'cancelled') {
      await applyStatusFromLinear(task, 'cancelled', actor.name, surface)
      announceToSurfaces(task.id, 'Reassigned on Linear; stopping here.', 'error')
    }
    broadcastTask(st, task.id)
    return
  }

  if (has('stateId') && change.state) {
    const status = statusOfLinearState(change.state)
    if (status && status !== synced.status && status !== task.status) {
      await applyStatusFromLinear(task, status, actor.name, surface)
    }
  }
  broadcastTask(st, task.id)
}

/**
 * A status change made on Linear, applied with the same gates the desktop's
 * PATCH goes through. On failure the snapshot is left alone, so the next
 * broadcast writes the task's real status back to Linear — the reconcile.
 */
async function applyStatusFromLinear(task: Task, status: TaskStatus, actorName: string, surface: TaskSurface): Promise<void> {
  const st = storage()
  const actor = { type: 'human' as const, id: null, name: actorName }
  const note = (body: string) =>
    st.taskAppendActivity(task.id, { kind: 'system', actorType: 'system', actorName: 'system', body, meta: { source: 'linear_issue' } })

  if (!isValidTaskTransition(task.status, status)) {
    note(`Linear moved the issue to ${status}, but ${task.status} → ${status} is not allowed here; the issue will be set back.`)
    return
  }
  if (status === 'done') {
    const res = await completeTaskAfterHumanReview(task.id, actor)
    if (!res.ok) {
      note(`Linear marked the issue done, but the task could not be finalized: ${res.reason}`)
      return
    }
    notifyTaskStatusChange(st, task, 'done', task.status)
    writeSnapshot(task.id, surface, { status: 'done' })
    return
  }
  st.taskUpdate(task.id, { status }, actor)
  writeSnapshot(task.id, surface, { status })
  notifyTaskStatusChange(st, task, status, task.status)
  if (status === 'in_progress') {
    // Dragging the issue to In Progress on Linear starts the agent, the same
    // way the board does.
    void maybeAutoDispatchTask(task.id).catch((err) => console.error('[Surfaces] auto-dispatch after Linear move failed:', err))
  } else if (status === 'in_review') {
    void maybeAutoIntegrate(task.id, status, actor).catch((err) => console.error('[Surfaces] auto-integrate after Linear move failed:', err))
  }
}

// ---- comments ----

export function isMirroredComment(commentId: string): boolean {
  return mirroredCommentIds.has(commentId)
}

/** A plain issue comment from Linear (not an agent-session reply) → activity. */
export function recordLinearComment(input: { issueId: string; commentId: string; authorName: string; body: string; actor: string }): void {
  const st = storage()
  if (input.commentId && mirroredCommentIds.has(input.commentId)) return
  const surface = st.taskSurfaceFind('linear_issue', input.issueId)
  const task = surface ? st.taskGet(surface.taskId) : null
  if (!task) return
  if (st.taskListActivity(task.id).some((a) => a.meta?.linearCommentId === input.commentId)) return
  st.taskAppendActivity(task.id, {
    kind: 'comment',
    actorType: 'human',
    actorName: input.authorName,
    body: input.body,
    meta: { source: 'linear_issue', linearCommentId: input.commentId, actor: input.actor },
  })
  broadcastTask(st, task.id)
}

async function mirrorComment(taskId: number, body: string, asUser?: string): Promise<void> {
  const surface = issueSurface(taskId)
  const orgId = surface ? orgOf(surface) : undefined
  if (!surface || !orgId) return
  const c = await createLinearComment(orgId, surface.externalId, body, asUser)
  mirroredCommentIds.add(c.id)
  if (mirroredCommentIds.size > 5000) mirroredCommentIds.delete(mirroredCommentIds.values().next().value as string)
}

/** A progress note the agent left with comment_project_task (design §9). */
export function mirrorAgentComment(taskId: number, agentName: string, body: string): void {
  void mirrorComment(taskId, body, `${agentName} (agent)`).catch((err) => {
    console.warn('[Surfaces] agent comment mirror failed:', err instanceof Error ? err.message : err)
  })
}

/** A comment a person wrote on the desktop task. */
export function mirrorHumanComment(taskId: number, authorName: string, body: string): void {
  const asUser = authorName && authorName !== 'You' ? authorName : getLinearAppConfig()?.linearUserName
  void mirrorComment(taskId, body, asUser).catch((err) => {
    console.warn('[Surfaces] human comment mirror failed:', err instanceof Error ? err.message : err)
  })
}

// ---- publish ----

export interface PublishedIssue {
  id: string
  identifier: string
  url: string
  title: string
  alreadyPublished?: boolean
  /** Subtasks that went to Linear as sub-issues in this call. */
  subtasks?: { published: number; failed: number }
}

interface PublishOpts {
  teamId?: string
  projectId?: string
  /** Linear issue id of the parent: the new issue becomes its sub-issue. */
  parentIssueId?: string
}

/** Publishes in flight, so a broadcast racing the button doesn't open a second issue. */
const publishing = new Map<number, Promise<PublishedIssue>>()
/** Subtasks whose publish failed, and when: broadcasts don't retry them until the cooldown passes. */
const publishFailedAt = new Map<number, number>()
const PUBLISH_RETRY_MS = 5 * 60 * 1000

/**
 * Create the Linear issue for a task and attach it as a surface (design
 * §11.1), then do the same for its subtasks, as sub-issues. Idempotent: an
 * already-published task returns its issue and only publishes what is missing
 * below it.
 */
export async function publishTaskToLinear(task: Task, opts: PublishOpts = {}): Promise<PublishedIssue> {
  const issue = await publishOne(task, opts)
  const subtasks = await publishSubtasks(task.id, true)
  return { ...issue, subtasks }
}

function publishOne(task: Task, opts: PublishOpts): Promise<PublishedIssue> {
  const existing = issueSurface(task.id)
  if (existing) {
    return Promise.resolve({
      id: existing.externalId,
      identifier: String(existing.meta?.identifier ?? ''),
      url: existing.url ?? '',
      title: task.title,
      alreadyPublished: true,
    })
  }
  const pending = publishing.get(task.id)
  if (pending) return pending
  const run = createIssueFor(task, opts).finally(() => publishing.delete(task.id))
  publishing.set(task.id, run)
  return run
}

/** Cancelled or archived subtasks that never made it to Linear stay off it. */
function shouldFollowParent(task: Task): boolean {
  return task.status !== 'cancelled' && task.archivedAt == null
}

/**
 * Publish every subtask (recursively) of a published task that has no issue
 * yet. Failures are logged and counted; one bad subtask doesn't stop the rest.
 * `retryFailed` (the button) ignores the cooldown broadcasts respect.
 */
async function publishSubtasks(
  parentTaskId: number,
  retryFailed = false,
): Promise<{ published: number; failed: number }> {
  const totals = { published: 0, failed: 0 }
  const parent = issueSurface(parentTaskId)
  if (!parent) return totals
  for (const child of storage().taskListChildren(parentTaskId)) {
    if (!issueSurface(child.id)) {
      if (!shouldFollowParent(child)) continue
      const failedAt = publishFailedAt.get(child.id)
      if (!retryFailed && failedAt != null && Date.now() - failedAt < PUBLISH_RETRY_MS) continue
      try {
        await publishOne(child, {
          teamId: parent.meta?.teamId as string | undefined,
          projectId: parent.meta?.projectId as string | undefined,
          parentIssueId: parent.externalId,
        })
        publishFailedAt.delete(child.id)
        totals.published += 1
      } catch (err) {
        publishFailedAt.set(child.id, Date.now())
        totals.failed += 1
        console.warn(`[Surfaces] could not publish subtask #${child.number}:`, err instanceof Error ? err.message : err)
        continue
      }
    }
    const below = await publishSubtasks(child.id, retryFailed)
    totals.published += below.published
    totals.failed += below.failed
  }
  return totals
}

/** A published task with subtasks not on Linear yet (created later, or before this existed). */
function hasUnpublishedSubtasks(taskId: number): boolean {
  return storage()
    .taskListChildren(taskId)
    .some((c) => shouldFollowParent(c) && !issueSurface(c.id))
}

async function createIssueFor(task: Task, opts: PublishOpts): Promise<PublishedIssue> {
  const st = storage()
  const local = getLinearAppConfig()
  if (!local) throw new Error('Linear is not connected')
  const teamId = opts.teamId || getLinearPublishTeam(task.projectId)
  if (!teamId) throw new Error('Pick a Linear team to publish to.')
  const projectId = opts.projectId
  const description = `${task.description ?? ''}\n\n---\nOpened from operon task #${task.number}`.trim()
  const issue = await createLinearIssue(local.orgId, {
    teamId,
    projectId: projectId || undefined,
    title: task.title,
    description,
    priority: toLinearPriority(task.priority),
    assigneeId: local.appUserId,
    createAsUser: local.linearUserName,
    parentId: opts.parentIssueId,
  })
  st.taskSurfaceUpsert({
    taskId: task.id,
    kind: 'linear_issue',
    externalId: issue.id,
    url: issue.url,
    meta: {
      identifier: issue.identifier,
      orgId: local.orgId,
      teamId: issue.teamId,
      projectId: issue.projectId ?? undefined,
      synced: { status: task.status, title: task.title, description: task.description ?? '', priority: task.priority },
      syncedStatus: task.status,
    },
  })
  st.taskAppendActivity(task.id, {
    kind: 'system',
    actorType: 'system',
    actorName: 'system',
    body: `Published to Linear as ${issue.identifier}`,
    meta: { event: 'linear.published', source: 'linear_issue', url: issue.url, identifier: issue.identifier },
  })
  void claimRoute('linear_issue', issue.id)
  rememberLinearPublishTeam(task.projectId, issue.teamId || teamId)
  // Status: the issue was created in the team's default state; project the
  // task's actual status right away (todo usually is the default, but not always).
  const surface = issueSurface(task.id)
  if (surface && task.status !== 'todo') {
    const states = await teamStates(local.orgId, issue.teamId).catch(() => [] as LinearWorkflowState[])
    const state = pickLinearState(states, task.status)
    if (state) await updateLinearIssue(local.orgId, issue.id, { stateId: state.id }).catch(() => undefined)
  }
  broadcastTask(st, task.id)
  return { id: issue.id, identifier: issue.identifier, url: issue.url, title: issue.title }
}

