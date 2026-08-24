// HTTP surface for the Spec-Driven Development (SDD) layer.
// Human/UI + programmatic endpoints: channel toggle, promote, artifact read/write/approve.
// Agent-facing equivalents live in the taskboard MCP (create_spec_task / write_artifact).

import { Hono } from 'hono'
import type { SddStorage } from '../services/sdd/sdd-service.js'
import {
  promoteToTask,
  writeArtifact,
  approveArtifact,
  decomposePlan,
  mergeChildIntoParent,
  sedimentChange,
  detectAndApplyDrift,
  readArtifactContent,
} from '../services/sdd/sdd-service.js'
import { broadcastTask } from '../services/task-events.js'
import type { ArtifactKind } from '../types/task.js'

const ARTIFACT_KINDS: ArtifactKind[] = ['spec', 'plan', 'acceptance', 'spec_delta']

export function sddRoutes(storage: SddStorage) {
  const router = new Hono()

  // Promote a converged channel discussion into an SDD parent task (§7, stage 2).
  router.post('/channels/:id/promote', async (c) => {
    const channelId = parseInt(c.req.param('id'), 10)
    const body = await c.req
      .json<{ authorAgentId?: number; title?: string; messageId?: number | null; description?: string }>()
      .catch(
        () =>
          ({}) as {
            authorAgentId?: number
            title?: string
            messageId?: number | null
            description?: string
          },
      )
    if (!body.authorAgentId || !body.title) {
      return c.json({ error: 'authorAgentId and title are required' }, 400)
    }
    try {
      const task = await promoteToTask(storage, {
        source: { kind: 'channel', channelId, messageId: body.messageId ?? null },
        authorAgentId: body.authorAgentId,
        title: body.title,
        description: body.description,
      })
      broadcastTask(storage, task.id)
      return c.json({ task })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'promote failed' }, 400)
    }
  })

  // List a task's artifacts with current content (for the detail-page spec panel).
  router.get('/tasks/:id/artifacts', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const task = storage.taskGet(id)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    // Drift check (§5.5): demote any approved artifact whose file changed since signing.
    const demoted = await detectAndApplyDrift(storage, task)
    if (demoted.length > 0) broadcastTask(storage, id)
    const rows = storage.taskArtifactList(id)
    const artifacts = await Promise.all(
      rows.map(async (a) => ({ ...a, content: await readArtifactContent(storage, task, a.kind) })),
    )
    return c.json({ artifacts })
  })

  // Write/replace an artifact as the human owner (bypasses the agent single-writer lock, §5.4).
  router.post('/tasks/:id/artifacts/:kind', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const kind = c.req.param('kind') as ArtifactKind
    if (!ARTIFACT_KINDS.includes(kind)) return c.json({ error: 'Invalid artifact kind' }, 400)
    const body = await c.req
      .json<{ content?: string; actorName?: string }>()
      .catch(() => ({}) as { content?: string; actorName?: string })
    try {
      const artifact = await writeArtifact(storage, {
        taskId: id,
        kind,
        content: body.content ?? '',
        caller: { type: 'human', id: null, name: body.actorName?.trim() || 'You' },
      })
      broadcastTask(storage, id)
      return c.json({ artifact })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'write failed' }, 400)
    }
  })

  // Decompose an approved plan into child tasks (§7, stage 3). Human-triggered only —
  // agents have no decompose tool; Dispatch (routes/task.ts prepareSddParent) is the
  // normal path and this endpoint is the standalone escape hatch for the human owner.
  router.post('/tasks/:id/decompose', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const body = await c.req.json<{ actorName?: string }>().catch(() => ({}) as { actorName?: string })
    try {
      const { created, skipped } = await decomposePlan(storage, id, {
        type: 'human',
        id: null,
        name: body.actorName?.trim() || 'You',
      })
      for (const t of created) broadcastTask(storage, t.id)
      broadcastTask(storage, id)
      return c.json({ created, skipped })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'decompose failed' }, 400)
    }
  })

  // Sediment a change's delta into the living spec (§13). Preview by default;
  // ?apply=1 (or body.apply) writes it onto the change branch. Conflicts halt (409).
  router.post('/tasks/:id/sediment', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const body = await c.req
      .json<{ apply?: boolean; actorName?: string }>()
      .catch(() => ({}) as { apply?: boolean; actorName?: string })
    const apply = body.apply === true || c.req.query('apply') === '1'
    try {
      const result = await sedimentChange(
        storage,
        id,
        { type: 'human', id: null, name: body.actorName?.trim() || 'You' },
        { apply },
      )
      if (result.applied) broadcastTask(storage, id)
      return c.json({ result }, result.conflicts.length > 0 ? 409 : 200)
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'sediment failed' }, 400)
    }
  })

  // Merge a finished subtask's branch back into its parent change branch (§7 ⑤).
  router.post('/tasks/:id/merge', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const body = await c.req.json<{ actorName?: string }>().catch(() => ({}) as { actorName?: string })
    try {
      const result = await mergeChildIntoParent(storage, id, {
        type: 'human',
        id: null,
        name: body.actorName?.trim() || 'You',
      })
      broadcastTask(storage, id)
      const parent = storage.taskGet(storage.taskGet(id)?.parentTaskId ?? -1)
      if (parent) broadcastTask(storage, parent.id)
      return c.json({ result })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'merge failed' }, 409)
    }
  })

  // Approve an artifact — Gate-0 (spec) / Gate-3 (acceptance) human signing (§6).
  router.post('/tasks/:id/artifacts/:kind/approve', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const kind = c.req.param('kind') as ArtifactKind
    if (!ARTIFACT_KINDS.includes(kind)) return c.json({ error: 'Invalid artifact kind' }, 400)
    const body = await c.req
      .json<{ actorName?: string }>()
      .catch(() => ({}) as { actorName?: string })
    try {
      const artifact = await approveArtifact(storage, {
        taskId: id,
        kind,
        approver: { type: 'human', id: null, name: body.actorName?.trim() || 'You' },
      })
      broadcastTask(storage, id)
      return c.json({ artifact })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'approve failed' }, 400)
    }
  })

  return router
}
