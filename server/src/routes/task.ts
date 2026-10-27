import { taskSubtreeIds } from '../../../shared/task-tree.js'
import { SPEC_STAGES } from '../../../shared/spec.js'
import { withTaskExecution } from '../services/task-execution.js'
import { subscribeWorkflowEvents } from '../services/workflow/hub.js'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { NotificationStorageAdapter, TaskStorageAdapter } from '../storage/interface.js'
import {
  dispatchProjectTask,
  wakeTaskBinding,
  resumeProjectTask,
  TaskBlockedError,
  SpecDesignChangedError,
} from '../services/channel/agent-orchestrator.js'
import { broadcastTask } from '../services/task-events.js'
import { onTaskEvent } from '../services/channel-bus.js'
import { commentOnTaskAsHuman, updateTaskAsHuman } from '../services/task-human-actions.js'
import {
  type CreateTaskInput,
  type CreateTaskLabelInput,
  type ListTasksQuery,
  type TaskPriority,
  type TaskStatus,
  type UpdateTaskInput,
} from '../types/task.js'

const STATUSES: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done', 'cancelled']

/** `?projectId=` → that project; absent (or not a positive id) → every project, for the global board. */
function projectScope(raw: string | undefined): number | undefined {
  const id = parseInt(raw ?? '', 10)
  return Number.isFinite(id) && id > 0 ? id : undefined
}

/**
 * Project-level task routes (the "local Linear" board). Mounted at /api/tasks.
 * Project scope is passed via ?projectId= (query) or the request body, matching
 * the convention used elsewhere (e.g. /api/agents/:id/stop?projectId=). The
 * list reads (tasks, labels, stream) take no projectId for every project.
 */
export function taskRoutes(storage: TaskStorageAdapter & NotificationStorageAdapter) {
  const router = new Hono()

  // ---- Labels (registered before /:id so 'labels' is never parsed as an id) ----

  router.get('/labels', (c) => {
    return c.json({ labels: storage.taskListLabelDefs(projectScope(c.req.query('projectId'))) })
  })

  router.post('/labels', async (c) => {
    const input = await c.req.json<CreateTaskLabelInput>()
    if (!input.projectId || !input.name?.trim()) {
      return c.json({ error: 'projectId and name required' }, 400)
    }
    return c.json({ label: storage.taskCreateLabelDef(input) })
  })

  // ---- Live board / activity feed stream (SSE) ----
  // Registered before /:id so 'stream' is never parsed as an id.
  router.get('/stream', (c) => {
    const projectId = projectScope(c.req.query('projectId')) ?? null
    return streamSSE(c, async (stream) => {
      let closed = false
      stream.onAbort(() => {
        closed = true
      })
      const unsub = onTaskEvent(projectId, (event) => {
        if (closed) return
        stream.writeSSE({ data: JSON.stringify({ ...event, task: withTaskExecution(storage, event.task) }) }).catch(() => {})
      })
      const unsubWorkflow = subscribeWorkflowEvents(null, (event) => {
        if (closed || !['agent', 'started', 'settled'].includes(event.event.kind)) return
        for (const run of storage.specRunList(SPEC_STAGES)) {
          if (run.workflowRunId !== event.runId) continue
          const task = storage.taskGet(run.taskId)
          if (task && (projectId == null || task.projectId === projectId)) {
            const item = withTaskExecution(storage, { ...task, labels: storage.taskGetLabels(task.id) })
            stream.writeSSE({ data: JSON.stringify({ type: 'task_upsert', task: item }) }).catch(() => {})
          }
        }
      })
      try {
        // A reconnect gets a fresh snapshot so missed stop/start events cannot
        // leave a stale running animation on screen.
        for (const task of storage.taskList({ projectId: projectId ?? undefined, includeArchived: true })) {
          if (closed) break
          await stream.writeSSE({ data: JSON.stringify({ type: 'task_upsert', task: withTaskExecution(storage, task) }) })
        }
        while (!closed) {
          await new Promise<void>((resolve) => setTimeout(resolve, 1000))
        }
      } finally {
        unsub()
        unsubWorkflow()
      }
    })
  })

  // ---- Tasks ----

  router.get('/', (c) => {
    const query: ListTasksQuery = { projectId: projectScope(c.req.query('projectId')) }
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
    return c.json({ tasks: storage.taskList(query).map((task) => withTaskExecution(storage, task)) })
  })

  router.post('/', async (c) => {
    const input = await c.req.json<CreateTaskInput>()
    if (!input.projectId || !input.title?.trim()) {
      return c.json({ error: 'projectId and title required' }, 400)
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
    return c.json({ task: withTaskExecution(storage, detail) })
  })

  router.patch('/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const existing = storage.taskGet(id)
    if (!existing) return c.json({ error: 'Not found' }, 404)
    const body = (await c.req.json<UpdateTaskInput & { actorName?: string }>()) ?? {}
    const { actorName, ...updates } = body
    const res = await updateTaskAsHuman(storage, existing, updates, actorName?.trim() || 'You')
    if (!res.ok) return c.json(res.body as Record<string, unknown>, res.status)
    return c.json({ task: withTaskExecution(storage, storage.taskDetail(id)) })
  })

  router.post('/:id/archive', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const existing = storage.taskGet(id)
    if (!existing) return c.json({ error: 'Not found' }, 404)
    const body = await c.req
      .json<{ archived?: boolean; actorName?: string }>()
      .catch(() => ({}) as { archived?: boolean; actorName?: string })
    const archived = body.archived !== false // default to archiving
    storage.taskSetArchived(id, archived, { type: 'human', name: body.actorName?.trim() || 'You' })
    const projectTasks = storage.taskList({ projectId: existing.projectId, includeArchived: true })
    const subtreeIds = taskSubtreeIds(projectTasks, id)
    // Restoring brings back only the descendants archived along with the task;
    // the ones still archived didn't change.
    const tasks = projectTasks.filter((task) => subtreeIds.has(task.id) && (archived || task.archivedAt == null))
    for (const task of tasks) broadcastTask(storage, task.id)
    return c.json({ task: withTaskExecution(storage, storage.taskDetail(id)), tasks })
  })

  router.post('/:id/dispatch', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const task = storage.taskGet(id)
    if (!task) return c.json({ error: 'Not found' }, 404)
    const body = await c.req
      .json<{ assignedAgentId?: number }>()
      .catch(() => ({}) as { assignedAgentId?: number })
    const agentId = body.assignedAgentId ?? task.assignedAgentId
    if (!agentId) {
      return c.json({ error: 'assignedAgentId required — task is unassigned' }, 400)
    }
    try {
      await dispatchProjectTask(id, agentId)
    } catch (e) {
      if (e instanceof TaskBlockedError || e instanceof SpecDesignChangedError) return c.json({ error: e.message }, 409)
      return c.json({ error: e instanceof Error ? e.message : 'dispatch failed' }, 500)
    }
    return c.json({ task: withTaskExecution(storage, storage.taskDetail(id)) })
  })

  // Pick a dispatched task back up in its own session (after a restart killed
  // the turn, or the agent stopped short). A live session is left alone.
  router.post('/:id/resume', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    if (!storage.taskGet(id)) return c.json({ error: 'Not found' }, 404)
    try {
      const woke = await resumeProjectTask(id)
      return c.json({ woke, task: withTaskExecution(storage, storage.taskDetail(id)) })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'resume failed' }, 409)
    }
  })

  router.post('/:id/comments', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const task = storage.taskGet(id)
    if (!task) return c.json({ error: 'Not found' }, 404)
    const body = await c.req.json<{ body: string; actorName?: string }>()
    if (!body.body?.trim()) return c.json({ error: 'body required' }, 400)
    return c.json(commentOnTaskAsHuman(storage, task, body.body, body.actorName?.trim() || undefined))
  })

  // A comment that arrived from Linear / GitHub by someone other than the
  // task's owner was only recorded (design.md §8.5). The owner forwards it to
  // the agent from the desktop, deliberately.
  router.post('/:id/activities/:activityId/send-to-agent', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const activityId = parseInt(c.req.param('activityId'), 10)
    const task = storage.taskGet(id)
    if (!task) return c.json({ error: 'Not found' }, 404)
    const activity = storage.taskGetActivity(id, activityId)
    if (!activity || activity.kind !== 'comment') return c.json({ error: 'Comment not found' }, 404)
    if (activity.meta?.sent === true) return c.json({ error: 'Already sent' }, 409)
    if (task.bindingId == null) return c.json({ error: 'Task has no agent session' }, 409)
    const source = activity.meta?.source === 'github_pr' ? 'GitHub' : 'Linear'
    const woke = await wakeTaskBinding(
      task.bindingId,
      `From ${activity.actorName} on ${source} (forwarded by the task owner):\n\n${activity.body}`,
    )
    storage.taskAppendActivity(id, {
      kind: 'system',
      actorType: 'system',
      actorName: 'system',
      body: `Sent ${activity.actorName}'s comment to the agent`,
      meta: { event: 'comment.forwarded', author: activity.actorName, forwardedActivityId: activityId },
    })
    broadcastTask(storage, id)
    return c.json({ woke })
  })

  return router
}
