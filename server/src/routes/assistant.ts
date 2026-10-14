import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AssistantConfig } from '../../../shared/assistant.js'
import type { AssistantStorageAdapter, StorageAdapter } from '../storage/interface.js'
import type { OperonStateStorage } from '../services/assistant/operon-state.js'
import type { OperonActionsStorage } from '../services/assistant/operon-actions.js'
import { normalizeAttachments } from '../services/assistant/attachments.js'
import { isProfileFileName } from '../services/assistant/files.js'
import { getAssistantRuntime, resumeInterruptedAssistantWork } from '../services/assistant/runtime.js'
import { executeCronjob, setAssistantCronRunner, type CronjobStorage } from '../services/cronjob.js'

/** Personal assistant (docs/assistant/design.md). Mounted at /api/assistant. */
export function assistantRoutes(storage: StorageAdapter & AssistantStorageAdapter & CronjobStorage & OperonStateStorage & OperonActionsStorage) {
  const router = new Hono()
  const runtime = () => getAssistantRuntime(storage)
  // The app's scheduler times the heartbeat and scheduled tasks; running one wakes the assistant
  // (built on first use, so a heartbeat due after a restart brings it up on its own).
  setAssistantCronRunner((job) => runtime().runSchedule(job))
  // Tasks a restart cut off are carried on without waiting for someone to open the assistant.
  // A little after startup: the agents' availability is still being probed right now.
  setTimeout(() => {
    try {
      resumeInterruptedAssistantWork(storage)
    } catch (error) {
      console.warn('[assistant] could not resume interrupted tasks:', error)
    }
  }, 5_000).unref?.()

  // Registered first so 'stream' is never read as a path argument.
  router.get('/stream', (c) =>
    streamSSE(c, async (stream) => {
      let closed = false
      stream.onAbort(() => {
        closed = true
      })
      const unsubscribe = runtime().subscribe((event) => {
        if (!closed) stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {})
      })
      while (!closed) await new Promise<void>((resolve) => setTimeout(resolve, 1000))
      unsubscribe()
    }),
  )

  router.get('/state', async (c) => c.json(await runtime().state(c.req.query('locale'))))

  router.get('/messages', (c) => {
    const before = Number(c.req.query('before'))
    if (!Number.isFinite(before) || before <= 0) return c.json({ error: 'before required' }, 400)
    return c.json(runtime().olderMessages(before))
  })

  router.post('/messages', async (c) => {
    type Body = { text?: unknown; attachments?: unknown; id?: unknown }
    const body = await c.req.json<Body>().catch((): Body => ({}))
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    const attachments = normalizeAttachments(body.attachments)
    if (!text && attachments.length === 0) return c.json({ error: 'text or attachments required' }, 400)
    // The client shows the message under its own id before this answers; keeping it means the
    // reply and the stream's copy land on that same row.
    const id = typeof body.id === 'string' && /^[0-9a-f-]{36}$/i.test(body.id) ? body.id : undefined
    return c.json({ message: await runtime().send(text, attachments, id) })
  })

  router.post('/activities/:id/stop', async (c) => c.json({ stopped: await runtime().stopActivity(c.req.param('id')) }))

  router.post('/activities/:id/messages', async (c) => {
    const body = await c.req.json<{ text?: unknown }>().catch(() => ({}) as { text?: unknown })
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) return c.json({ error: 'text required' }, 400)
    const result = await runtime().followUp(c.req.param('id'), text)
    return result === 'missing' ? c.json({ error: 'not found' }, 404) : c.json({ result })
  })

  router.post('/approvals/:id', async (c) => {
    const body = await c.req.json<{ decision?: unknown }>().catch(() => ({}) as { decision?: unknown })
    const decision = body.decision
    if (decision !== 'allowed_once' && decision !== 'denied') {
      return c.json({ error: 'decision must be allowed_once or denied' }, 400)
    }
    const ok = runtime().answerApproval(c.req.param('id'), decision)
    return ok ? c.json({ ok }) : c.json({ error: 'not waiting for an answer' }, 404)
  })

  router.put('/files/:name', async (c) => {
    const name = c.req.param('name')
    if (!isProfileFileName(name)) return c.json({ error: 'unknown file' }, 404)
    const body = await c.req.json<{ content?: unknown }>().catch(() => ({}) as { content?: unknown })
    if (typeof body.content !== 'string') return c.json({ error: 'content required' }, 400)
    return c.json({ file: runtime().writeFile(name, body.content) })
  })

  router.patch('/schedules/:id', async (c) => {
    const body = await c.req.json<{ enabled?: unknown }>().catch(() => ({}) as { enabled?: unknown })
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled required' }, 400)
    try {
      const ok = runtime().setScheduleEnabled(Number(c.req.param('id')), body.enabled)
      return ok ? c.json({ ok }) : c.json({ error: 'not found' }, 404)
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })

  router.delete('/schedules/:id', (c) => {
    try {
      const ok = runtime().deleteSchedule(Number(c.req.param('id')))
      return ok ? c.json({ ok }) : c.json({ error: 'not found' }, 404)
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })

  /** Run one now, outside its timing (the scheduler's own path, so its record updates the same way). */
  router.post('/schedules/:id/run', (c) => {
    const id = Number(c.req.param('id'))
    if (!runtime().hasSchedule(id)) return c.json({ error: 'not found' }, 404)
    void executeCronjob(storage, id).catch((error: unknown) => console.error(`[assistant] run of schedule ${id} failed:`, error))
    return c.json({ started: id })
  })

  router.get('/config', (c) => c.json(runtime().getConfig()))

  router.put('/config', async (c) => {
    type Body = Partial<Record<keyof AssistantConfig, unknown>>
    const body = await c.req.json<Body>().catch((): Body => ({}))
    const patch: Partial<AssistantConfig> = {}
    const choice = (value: unknown) => {
      const v = value as { providerId?: unknown; modelId?: unknown } | null
      return v && typeof v.providerId === 'string' && v.providerId.trim()
        ? { providerId: v.providerId.trim(), modelId: typeof v.modelId === 'string' ? v.modelId.trim() : '' }
        : undefined
    }
    for (const key of ['main', 'worker'] as const) {
      if (body[key] === undefined) continue
      const value = choice(body[key])
      if (!value) return c.json({ error: `${key} must be { providerId, modelId }` }, 400)
      patch[key] = value
    }
    if (body.background !== undefined) {
      const value = body.background === null ? null : choice(body.background)
      if (value === undefined) return c.json({ error: 'background must be { providerId, modelId } or null' }, 400)
      patch.background = value
    }
    const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/
    for (const key of ['quietStart', 'quietEnd'] as const) {
      const value = body[key]
      if (value === undefined) continue
      if (typeof value !== 'string' || !hhmm.test(value)) return c.json({ error: `${key} must be HH:MM` }, 400)
      patch[key] = value
    }
    return c.json(runtime().setConfig(patch))
  })

  return router
}
