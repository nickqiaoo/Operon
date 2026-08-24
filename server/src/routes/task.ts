import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { NotificationStorageAdapter, TaskStorageAdapter } from '../storage/interface.js'
import {
  dispatchProjectTask,
  wakeTaskBinding,
  maybeAutoDispatchTask,
  maybeAutoIntegrate,
  completeTaskAfterHumanReview,
  dispatchVerifier,
} from '../services/channel/agent-orchestrator.js'
import {
  assertGateOrThrow,
  detectAndApplyDrift,
  approveArtifact,
  decomposePlan,
  nextDispatchableChildren,
  GateError,
  type SddStorage,
} from '../services/sdd/sdd-service.js'
import { broadcastTask } from '../services/task-events.js'
import { ensureParentTeam } from '../services/task-team.js'
import { onTaskEvent } from '../services/channel-bus.js'
import { notifyTaskStatusChange } from '../services/notification-service.js'
import {
  isValidTaskTransition,
  type CreateTaskInput,
  type CreateTaskLabelInput,
  type CreateTeamInput,
  type UpdateTeamInput,
  type ListTasksQuery,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type UpdateTaskInput,
} from '../types/task.js'

const STATUSES: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done', 'cancelled']

/**
 * Project-level task routes (the "local Linear" board). Mounted at /api/tasks.
 * Project scope is passed via ?projectId= (query) or the request body, matching
 * the convention used elsewhere (e.g. /api/agents/:id/stop?projectId=).
 *
 * Dispatch (assign → run an agent in a worktree) is NOT here — it arrives in P3.
 */
// Widened to SddStorage so gate transitions can run a drift check (§5.5) before
// evaluating; the injected SqliteStorage satisfies it. Non-SDD paths are unaffected.
/**
 * Shared "prepare an SDD parent for execution" step: refresh drift, auto-sign the
 * spec (+ plan), and decompose the plan into subtasks (idempotent). This is the
 * approve+decompose half that Dispatch folds in — extracted so both /prepare
 * (dialog: show me the subtasks first) and /dispatch (one-click) reuse it.
 * A spec with unresolved [NEEDS CLARIFICATION] still throws — a real "not ready".
 */
async function prepareSddParent(
  storage: TaskStorageAdapter & SddStorage,
  task: Task,
  actor: { type: 'human'; id: null; name: string },
): Promise<void> {
  await detectAndApplyDrift(storage, task)
  for (const kind of ['spec', 'plan'] as const) {
    const a = storage.taskArtifactGet(task.id, kind)
    if (a && a.status !== 'approved') {
      await approveArtifact(storage, { taskId: task.id, kind, approver: actor })
    }
  }
  if (storage.taskArtifactGet(task.id, 'plan')) {
    try {
      await decomposePlan(storage, task.id, actor)
    } catch (err) {
      // A plan with no [T###] rows / no content has nothing to split — treat the
      // parent as a single-task change rather than blocking.
      console.warn(`[Dispatch] decompose skipped for task ${task.id}:`, err)
    }
  }
}

export function taskRoutes(storage: TaskStorageAdapter & SddStorage & NotificationStorageAdapter) {
  const router = new Hono()

  // ---- Labels (registered before /:id so 'labels' is never parsed as an id) ----

  router.get('/labels', (c) => {
    const projectId = parseInt(c.req.query('projectId') ?? '0', 10)
    if (!projectId) return c.json({ error: 'projectId required' }, 400)
    return c.json({ labels: storage.taskListLabelDefs(projectId) })
  })

  router.post('/labels', async (c) => {
    const input = await c.req.json<CreateTaskLabelInput>()
    if (!input.projectId || !input.name?.trim()) {
      return c.json({ error: 'projectId and name required' }, 400)
    }
    return c.json({ label: storage.taskCreateLabelDef(input) })
  })

  // ---- Teams (registered before /:id) ----

  router.get('/teams', (c) => {
    const projectId = parseInt(c.req.query('projectId') ?? '0', 10)
    if (!projectId) return c.json({ error: 'projectId required' }, 400)
    return c.json({ teams: storage.teamList(projectId) })
  })

  router.post('/teams', async (c) => {
    const input = await c.req.json<CreateTeamInput>()
    if (!input.projectId || !input.name?.trim()) {
      return c.json({ error: 'projectId and name required' }, 400)
    }
    return c.json({ team: storage.teamCreate(input) })
  })

  router.patch('/teams/:teamId', async (c) => {
    const teamId = parseInt(c.req.param('teamId'), 10)
    const existing = storage.teamGet(teamId)
    if (!existing) return c.json({ error: 'Not found' }, 404)
    const body: UpdateTeamInput =
      (await c.req.json<UpdateTeamInput>().catch((): UpdateTeamInput => ({}))) ?? {}
    const updates: UpdateTeamInput = {}
    if (body.name !== undefined) {
      const name = body.name.trim()
      if (!name) return c.json({ error: 'name required' }, 400)
      updates.name = name
    }
    if (body.color !== undefined) {
      const color = body.color.trim()
      if (!color) return c.json({ error: 'color required' }, 400)
      updates.color = color
    }
    const team = storage.teamUpdate(teamId, updates)
    if (!team) return c.json({ error: 'Not found' }, 404)
    return c.json({ team })
  })

  router.delete('/teams/:teamId', (c) => {
    const teamId = parseInt(c.req.param('teamId'), 10)
    if (!storage.teamGet(teamId)) return c.json({ error: 'Not found' }, 404)
    const affected = storage.taskListByTeam(teamId)
    storage.teamDelete(teamId)
    for (const task of affected) broadcastTask(storage, task.id)
    return c.json({ success: true })
  })

  // ---- Live board / activity feed stream (SSE) ----
  // Registered before /:id so 'stream' is never parsed as an id.
  router.get('/stream', (c) => {
    const projectId = parseInt(c.req.query('projectId') ?? '0', 10)
    return streamSSE(c, async (stream) => {
      let closed = false
      stream.onAbort(() => {
        closed = true
      })
      const unsub = onTaskEvent(projectId, (event) => {
        if (closed) return
        stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {})
      })
      while (!closed) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1000))
      }
      unsub()
    })
  })

  // ---- Tasks ----

  router.get('/', (c) => {
    const projectId = parseInt(c.req.query('projectId') ?? '0', 10)
    if (!projectId) return c.json({ error: 'projectId required' }, 400)
    const query: ListTasksQuery = { projectId }
    const status = c.req.query('status')
    if (status && STATUSES.includes(status as TaskStatus)) query.status = status as TaskStatus
    const assignee = c.req.query('assignee')
    if (assignee) query.assignedAgentId = parseInt(assignee, 10)
    const label = c.req.query('label')
    if (label) query.labelId = parseInt(label, 10)
    const priority = c.req.query('priority')
    if (priority) query.priority = parseInt(priority, 10) as TaskPriority
    const includeArchived = c.req.query('includeArchived')
    if (includeArchived === '1' || includeArchived === 'true') query.includeArchived = true
    return c.json({ tasks: storage.taskList(query) })
  })

  router.post('/', async (c) => {
    const input = await c.req.json<CreateTaskInput>()
    if (!input.projectId || !input.title?.trim()) {
      return c.json({ error: 'projectId and title required' }, 400)
    }
    // Epic path: a sub-task inherits its parent's team so siblings coordinate.
    // If the parent has no team yet, decomposing it forms one (named after the
    // parent). An explicit teamId on the request wins.
    if (input.parentTaskId && input.teamId == null) {
      const parent = storage.taskGet(input.parentTaskId)
      if (parent) {
        const [teamId, parentChanged] = ensureParentTeam(storage, parent)
        if (parentChanged) broadcastTask(storage, parent.id)
        input.teamId = teamId
      }
    }
    const task = storage.taskCreate(input)
    broadcastTask(storage, task.id)
    return c.json({ task: storage.taskDetail(task.id) })
  })

  /**
   * "Which task owns this worktree?" — lets a workspace that was created by
   * Dispatch link back to the task it came from. A plain workspace has no task,
   * which is a normal answer (`{ task: null }`), not a 404.
   */
  router.get('/by-workspace/:workspaceId', (c) => {
    const workspaceId = parseInt(c.req.param('workspaceId'), 10)
    if (!Number.isFinite(workspaceId)) return c.json({ error: 'Invalid workspaceId' }, 400)
    return c.json({ task: storage.taskGetByWorkspace(workspaceId) })
  })

  router.get('/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const detail = storage.taskDetail(id)
    if (!detail) return c.json({ error: 'Not found' }, 404)
    return c.json({ task: detail })
  })

  router.patch('/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const existing = storage.taskGet(id)
    if (!existing) return c.json({ error: 'Not found' }, 404)
    const body = (await c.req.json<UpdateTaskInput & { actorName?: string }>()) ?? {}
    const { actorName, ...updates } = body
    if (updates.status !== undefined && !isValidTaskTransition(existing.status, updates.status)) {
      return c.json({ error: `Invalid transition: ${existing.status} → ${updates.status}` }, 400)
    }
    if (updates.status !== undefined) {
      // Human Done is the review sign-off. It performs the required merge first:
      // SDD children merge into the parent branch; ordinary tasks and SDD parents
      // merge their branch into the default branch. Only then is the task marked done.
      if (updates.status === 'done') {
        const res = await completeTaskAfterHumanReview(id, {
          type: 'human',
          id: null,
          name: actorName?.trim() || 'You',
        })
        if (!res.ok) {
          return res.gateDetail ? c.json(res.gateDetail, 409) : c.json({ error: res.reason }, 409)
        }
        notifyTaskStatusChange(storage, existing, 'done', existing.status)
        return c.json({ task: storage.taskDetail(id) })
      }
      // Demote any drifted approved artifact first, so the gate sees fresh state.
      if (existing.sddManaged) await detectAndApplyDrift(storage, existing)
      try {
        assertGateOrThrow(storage, existing, updates.status)
      } catch (e) {
        if (e instanceof GateError) return c.json(e.detail, 409)
        throw e
      }
    }
    storage.taskUpdate(id, updates, { type: 'human', name: actorName?.trim() || 'You' })
    broadcastTask(storage, id)
    if (updates.status !== undefined) {
      // Inbox: human moved the task (e.g. → in_review, cancelled).
      notifyTaskStatusChange(storage, existing, updates.status, existing.status)
    }
    // Moving a task to in_progress with an assignee should actually start it
    // running in its worktree — not just flip a DB field (guarded inside).
    if (updates.status === 'in_progress') {
      void maybeAutoDispatchTask(id).catch((err) =>
        console.error('[Task] auto-dispatch after PATCH failed:', err),
      )
    } else if (updates.status === 'in_review') {
      // Review-ready only. SDD child merge happens later when a human marks Done.
      void maybeAutoIntegrate(id, updates.status, {
        type: 'human',
        id: null,
        name: actorName?.trim() || 'You',
      }).catch((err) => console.error('[Task] auto-integrate after PATCH failed:', err))
    }
    return c.json({ task: storage.taskDetail(id) })
  })

  // Run an independent verifier over a completed change (opt-in, §11.2⑦). The
  // parent must already be in review — Gate-2p guarantees every subtask merged, so
  // the verifier never reviews a half-finished change.
  router.post('/:id/verify', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const task = storage.taskGet(id)
    if (!task) return c.json({ error: 'Not found' }, 404)
    const body = await c.req
      .json<{ agentId?: number }>()
      .catch(() => ({}) as { agentId?: number })
    if (!body.agentId) return c.json({ error: 'agentId required' }, 400)
    try {
      await dispatchVerifier(id, body.agentId)
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'verify dispatch failed' }, 409)
    }
    return c.json({ task: storage.taskDetail(id) })
  })

  router.post('/:id/archive', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    if (!storage.taskGet(id)) return c.json({ error: 'Not found' }, 404)
    const body = await c.req
      .json<{ archived?: boolean; actorName?: string }>()
      .catch(() => ({}) as { archived?: boolean; actorName?: string })
    const archived = body.archived !== false // default to archiving
    storage.taskSetArchived(id, archived, { type: 'human', name: body.actorName?.trim() || 'You' })
    broadcastTask(storage, id)
    return c.json({ task: storage.taskDetail(id) })
  })

  // Prepare an SDD parent for the dispatch dialog: auto-sign spec/plan + decompose,
  // then return the resulting subtasks so the UI can assign an agent to each before
  // dispatching. Idempotent — re-running returns the same subtasks (none = a tiny
  // single-task change, the caller should just /dispatch).
  router.post('/:id/prepare', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const task = storage.taskGet(id)
    if (!task) return c.json({ error: 'Not found' }, 404)
    if (!task.sddManaged || task.parentTaskId != null) {
      return c.json({ error: 'prepare is only for SDD parent tasks' }, 400)
    }
    const body = await c.req
      .json<{ actorName?: string }>()
      .catch(() => ({}) as { actorName?: string })
    try {
      await prepareSddParent(storage, task, {
        type: 'human',
        id: null,
        name: body.actorName?.trim() || 'You',
      })
    } catch (e) {
      if (e instanceof GateError) return c.json(e.detail, 409)
      return c.json({ error: e instanceof Error ? e.message : 'prepare failed' }, 500)
    }
    const subtasks = storage
      .taskListChildren(id)
      .filter((ch) => ch.status !== 'cancelled')
      .map((ch) => ({
        id: ch.id,
        number: ch.number,
        title: ch.title,
        planAnchor: ch.planAnchor,
        claimedAcs: ch.claimedAcs,
        assignedAgentId: ch.assignedAgentId,
      }))
    return c.json({ subtasks })
  })

  router.post('/:id/dispatch', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const task = storage.taskGet(id)
    if (!task) return c.json({ error: 'Not found' }, 404)
    const body = await c.req
      .json<{ assignedAgentId?: number; actorName?: string; subtaskAgents?: Record<string, number> }>()
      .catch(
        () => ({}) as { assignedAgentId?: number; actorName?: string; subtaskAgents?: Record<string, number> },
      )
    const agentId = body.assignedAgentId ?? task.assignedAgentId
    if (!agentId) {
      return c.json({ error: 'assignedAgentId required — task is unassigned' }, 400)
    }
    try {
      // SDD parent: Dispatch is the single human action and stands in for the
      // approve/decompose gates. A solo author who just reviewed the spec/plan
      // shouldn't click Approve and Decompose separately — pressing Dispatch
      // means "I accept this design, start it". So we fold those steps in here.
      if (task.sddManaged && task.parentTaskId == null) {
        const actor = { type: 'human' as const, id: null, name: body.actorName?.trim() || 'You' }
        await prepareSddParent(storage, task, actor)
        const children = storage
          .taskListChildren(task.id)
          .filter((ch) => ch.status !== 'done' && ch.status !== 'cancelled')
        if (children.length > 0) {
          // Decomposed feature: the parent coordinates, each child executes.
          assertGateOrThrow(storage, task, 'in_progress')
          storage.taskUpdate(
            task.id,
            { status: 'in_progress', assignedAgentId: agentId },
            { type: 'human', name: actor.name },
          )
          broadcastTask(storage, task.id)
          // Pin every child's agent NOW, including ones held back for a later wave —
          // the deferred dispatch (on sibling Done) reads assignedAgentId, and the
          // dialog's per-subtask choice is only available here.
          for (const child of children) {
            // Per-subtask agent from the dispatch dialog wins; else the child's own
            // assignee; else the default agent chosen for this dispatch.
            const childAgent =
              body.subtaskAgents?.[String(child.id)] ?? child.assignedAgentId ?? agentId
            if (child.assignedAgentId !== childAgent) {
              storage.taskUpdate(
                child.id,
                { assignedAgentId: childAgent },
                { type: 'human', name: actor.name },
              )
            }
          }
          // Only the first wave starts; rows without `[P]` are barriers, so their
          // successors wait until the earlier wave is Done and merged into the parent.
          const ready = await nextDispatchableChildren(storage, task)
          const readyIds = new Set(ready.map((r) => r.id))
          for (const child of ready) {
            await dispatchProjectTask(child.id, child.assignedAgentId ?? agentId)
          }
          const waiting = children.filter((c) => !readyIds.has(c.id))
          if (waiting.length > 0) {
            storage.taskAppendActivity(task.id, {
              kind: 'system',
              actorType: 'human',
              actorName: actor.name,
              body:
                `Started ${ready.length} subtask(s); ${waiting.length} queued behind them ` +
                `(${waiting.map((w) => w.planAnchor ?? `#${w.number}`).join(', ')}) — ` +
                `each starts once the wave before it is Done.`,
              meta: { started: ready.length, queued: waiting.length },
            })
            broadcastTask(storage, task.id)
          }
        } else {
          // Tiny single-task change: the parent executes in its own change worktree.
          assertGateOrThrow(storage, task, 'in_progress')
          await dispatchProjectTask(task.id, agentId)
        }
        return c.json({ task: storage.taskDetail(id) })
      }

      // Non-SDD task, or an SDD child dispatched directly.
      if (task.sddManaged) await detectAndApplyDrift(storage, task)
      assertGateOrThrow(storage, task, 'in_progress')
      await dispatchProjectTask(id, agentId)
    } catch (e) {
      if (e instanceof GateError) return c.json(e.detail, 409)
      return c.json({ error: e instanceof Error ? e.message : 'dispatch failed' }, 500)
    }
    return c.json({ task: storage.taskDetail(id) })
  })

  router.post('/:id/comments', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const task = storage.taskGet(id)
    if (!task) return c.json({ error: 'Not found' }, 404)
    const body = await c.req.json<{ body: string; actorName?: string }>()
    const text = body.body?.trim()
    if (!text) return c.json({ error: 'body required' }, 400)
    const activity = storage.taskAppendActivity(id, {
      kind: 'comment',
      actorType: 'human',
      actorName: body.actorName?.trim() || 'You',
      body: body.body,
    })
    broadcastTask(storage, id)

    // Wake the task's agent so a human comment steers the running turn (or
    // resurrects an idle session) — the local analog of Linear's "post a
    // comment to resurrect the session". Fire-and-forget so the comment lands
    // instantly; the agent's reply arrives via the activity feed. Only tasks
    // that have been dispatched (bindingId set) have a session to wake.
    let woke = false
    if (task.bindingId != null) {
      const commenter = body.actorName?.trim() || 'the human'
      const notification =
        `[New comment on task #${task.number} from ${commenter}]: ${text}\n` +
        `Re-read the full task with get_project_task(task: ${task.number}) if you need context, ` +
        `then continue the work or reply with comment_project_task(task: ${task.number}, body: "...").`
      woke = true
      void wakeTaskBinding(task.bindingId, notification).catch((err) => {
        console.warn(`[Task] wake-on-comment failed for task=${id}:`, err)
      })
    }
    return c.json({ activity, woke })
  })

  return router
}
