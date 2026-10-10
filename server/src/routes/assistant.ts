import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AssistantConfig } from '../../../shared/assistant.js'
import type { AssistantStorageAdapter, StorageAdapter } from '../storage/interface.js'
import { normalizeAttachments } from '../services/assistant/attachments.js'
import { isProfileFileName } from '../services/assistant/files.js'
import { getAssistantRuntime } from '../services/assistant/runtime.js'
import { executeCronjob, setAssistantCronRunner, type CronjobStorage } from '../services/cronjob.js'

/** Personal assistant (docs/assistant/design.md). Mounted at /api/assistant. */
export function assistantRoutes(storage: StorageAdapter & AssistantStorageAdapter & CronjobStorage) {
  const router = new Hono()
  const runtime = () => getAssistantRuntime(storage)
  // The app's scheduler times the heartbeat and scheduled tasks; running one wakes the assistant
  // (built on first use, so a heartbeat due after a restart brings it up on its own).
  setAssistantCronRunner((job) => runtime().runSchedule(job))

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
    type Body = { text?: unknown; attachments?: unknown }
    const body = await c.req.json<Body>().catch((): Body => ({}))
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    const attachments = normalizeAttachments(body.attachments)
    if (!text && attachments.length === 0) return c.json({ error: 'text or attachments required' }, 400)
    return c.json({ message: await runtime().send(text, attachments) })
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
    if (decision !== 'allowed_once' && decision !== 'always_allowed' && decision !== 'denied') {
      return c.json({ error: 'decision must be allowed_once, always_allowed or denied' }, 400)
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

  router.delete('/grants/:id', (c) => {
    const ok = runtime().revokeGrant(c.req.param('id'))
    return ok ? c.json({ ok }) : c.json({ error: 'not found' }, 404)
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
    if (typeof body.mainModel === 'string') patch.mainModel = body.mainModel.trim()
    if (typeof body.workerModel === 'string') patch.workerModel = body.workerModel.trim()
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
