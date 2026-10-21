/**
 * OperonSpec HTTP surface — what the spec card in the chat and the task page call.
 *
 * Both gates live here and nowhere else: the chat card and the task page hit
 * the same endpoints, so approving from either is the same act. Starting a spec
 * and answering its questions are the chat agent's job (taskboard tools); the
 * routes for them exist only so the UI can retry or answer directly.
 */

import { Hono } from 'hono'
import type { TaskActor } from '../types/task.js'
import {
  SpecError,
  answerSpecQuestions,
  approveSpecDesign,
  reapproveSpecDesign,
  getSpecView,
  requestSpecChanges,
  resumeSpec,
  signOffSpec,
  stopSpec,
} from '../services/spec/spec-service.js'
import type { BuildStorage } from '../services/spec/build-run.js'
import { acceptSwitchProposal, dismissSwitchProposal, switchSpecSeat } from '../services/spec/switch.js'
import { getSpecRoleSettings, setSpecRoleSettings, usableProviders } from '../services/spec/role-settings.js'
import { SPEC_STAGES, isSpecRole } from '../types/spec.js'

function humanActor(name: unknown): TaskActor {
  return { type: 'human', id: null, name: typeof name === 'string' && name.trim() ? name.trim() : 'You' }
}

export function specRoutes(storage: BuildStorage) {
  const router = new Hono()

  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    return { message, status: error instanceof SpecError ? (400 as const) : (500 as const) }
  }

  // Settings → OperonSpec: who plays each role in a new spec.
  router.get('/settings/roles', (c) => c.json({ roles: getSpecRoleSettings(), available: usableProviders() }))
  router.put('/settings/roles', async (c) => {
    const body = await c.req.json<{ roles?: unknown }>().catch((): { roles?: unknown } => ({}))
    return c.json({ roles: setSpecRoleSettings(body.roles) })
  })

  // The specs a chat started that are not done yet, newest first — the bar above its composer.
  router.get('/by-chat/:chatId', (c) => {
    const chatId = Number(c.req.param('chatId'))
    const specs = storage
      .specRunList(SPEC_STAGES.filter((stage) => stage !== 'done'))
      .map((run) => ({ run, task: storage.taskGet(run.taskId) }))
      .filter(({ task }) => task != null && task.sourceChatId === chatId)
      .sort((a, b) => b.run.createdAt - a.run.createdAt)
      .map(({ run, task }) => ({ taskId: run.taskId, taskNumber: task!.number, title: task!.title, stage: run.stage }))
    return c.json({ specs })
  })

  router.get('/:taskId', async (c) => {
    try {
      return c.json({ spec: await getSpecView(storage, Number(c.req.param('taskId'))) })
    } catch (error) {
      const { message, status } = fail(error)
      return c.json({ error: message }, status)
    }
  })

  router.post('/:taskId/approve', async (c) => {
    type ApproveBody = { actorName?: string; implementers?: Record<string, string>; concurrency?: number }
    const body = await c.req.json<ApproveBody>().catch((): ApproveBody => ({}))
    try {
      const tickets = await approveSpecDesign(storage, Number(c.req.param('taskId')), humanActor(body.actorName), {
        implementers: body.implementers,
        concurrency: body.concurrency,
      })
      return c.json({ tickets: tickets.map((t) => ({ id: t.id, number: t.number, title: t.title })) })
    } catch (error) {
      const { message, status } = fail(error)
      return c.json({ error: message }, status)
    }
  })

  // Gate 2: merge the built and reviewed change into the default branch.
  router.post('/:taskId/signoff', async (c) => {
    const body = await c.req.json<{ actorName?: string }>().catch(() => ({ actorName: undefined }))
    try {
      const { pending } = await signOffSpec(storage, Number(c.req.param('taskId')), humanActor(body.actorName))
      return c.json({ ok: true, ...(pending ? { pending } : {}) })
    } catch (error) {
      const { message, status } = fail(error)
      return c.json({ error: message }, status)
    }
  })

  router.post('/:taskId/reapprove', async (c) => {
    const body = await c.req.json<{ actorName?: string }>().catch(() => ({ actorName: undefined }))
    try {
      await reapproveSpecDesign(storage, Number(c.req.param('taskId')), humanActor(body.actorName))
      return c.json({ ok: true })
    } catch (error) {
      const { message, status } = fail(error)
      return c.json({ error: message }, status)
    }
  })

  router.post('/:taskId/request-changes', async (c) => {
    const body = await c.req
      .json<{ comment?: string; redesign?: boolean; actorName?: string }>()
      .catch((): { comment?: string; redesign?: boolean; actorName?: string } => ({}))
    try {
      const runId = await requestSpecChanges(
        storage,
        Number(c.req.param('taskId')),
        { comment: body.comment ?? '', redesign: body.redesign === true },
        humanActor(body.actorName),
      )
      return c.json({ runId })
    } catch (error) {
      const { message, status } = fail(error)
      return c.json({ error: message }, status)
    }
  })

  router.post('/:taskId/answers', async (c) => {
    const body = await c.req.json<{ answers?: string }>().catch((): { answers?: string } => ({}))
    try {
      return c.json({ runId: await answerSpecQuestions(storage, Number(c.req.param('taskId')), body.answers ?? '') })
    } catch (error) {
      const { message, status } = fail(error)
      return c.json({ error: message }, status)
    }
  })

  router.post('/:taskId/resume', async (c) => {
    try {
      return c.json({ runId: await resumeSpec(storage, Number(c.req.param('taskId'))) })
    } catch (error) {
      const { message, status } = fail(error)
      return c.json({ error: message }, status)
    }
  })

  // Move a role (or one ticket's implementer/reviewer) to another agent.
  router.post('/:taskId/switch', async (c) => {
    type SwitchBody = { role?: unknown; index?: number; ticketKey?: string; providerId?: string; modelId?: string; actorName?: string }
    const body = await c.req.json<SwitchBody>().catch((): SwitchBody => ({}))
    try {
      if (!isSpecRole(body.role)) throw new SpecError('Say which role to switch')
      const message = await switchSpecSeat(
        storage,
        Number(c.req.param('taskId')),
        {
          role: body.role,
          ...(typeof body.index === 'number' ? { index: body.index } : {}),
          ...(body.ticketKey ? { ticketKey: body.ticketKey } : {}),
          to: { providerId: body.providerId ?? '', ...(body.modelId ? { modelId: body.modelId } : {}) },
        },
        humanActor(body.actorName),
      )
      return c.json({ message })
    } catch (error) {
      const { message, status } = fail(error)
      return c.json({ error: message }, status)
    }
  })

  // The coordinator's proposed switch: yes or no.
  router.post('/:taskId/proposal/accept', async (c) => {
    const body = await c.req.json<{ actorName?: string }>().catch(() => ({ actorName: undefined }))
    try {
      return c.json({ message: await acceptSwitchProposal(storage, Number(c.req.param('taskId')), humanActor(body.actorName)) })
    } catch (error) {
      const { message, status } = fail(error)
      return c.json({ error: message }, status)
    }
  })

  router.post('/:taskId/proposal/dismiss', async (c) => {
    const body = await c.req.json<{ actorName?: string; note?: string }>().catch((): { actorName?: string; note?: string } => ({}))
    try {
      await dismissSwitchProposal(storage, Number(c.req.param('taskId')), humanActor(body.actorName), body.note)
      return c.json({ ok: true })
    } catch (error) {
      const { message, status } = fail(error)
      return c.json({ error: message }, status)
    }
  })

  router.post('/:taskId/stop', (c) => {
    try {
      return c.json({ stopped: stopSpec(storage, Number(c.req.param('taskId'))) })
    } catch (error) {
      const { message, status } = fail(error)
      return c.json({ error: message }, status)
    }
  })

  return router
}
