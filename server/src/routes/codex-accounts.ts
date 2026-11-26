import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { Hono } from 'hono'
import { getRuntime } from '../services/ai/state.js'

export function codexAccountRoutes() {
  const router = new Hono()
  const accounts = () => getRuntime().codex.accounts
  router.onError((error, c) => c.json({ error: error.message }, 400))
  router.get('/', async c => c.json(await accounts().getState(c.req.query('refresh') === '1')))
  router.get('/selection', c => streamSSE(c, async stream => {
    let finish!: () => void
    const closed = new Promise<void>(resolve => { finish = resolve })
    stream.onAbort(finish)
    const off = accounts().subscribeSelection(revision => {
      void stream.writeSSE({ data: JSON.stringify(revision) }).catch(finish)
    })
    try { await closed } finally { off() }
  }))
  router.post('/login', async c => {
    const { device, id } = await c.req.json<{ device?: boolean; id?: string }>()
    return c.json(await accounts().startLogin(device === true, id))
  })
  router.post('/cancel', async c => { await accounts().cancelLogin(); return c.json({ success: true }) })
  router.put('/automatic', async c => {
    const { enabled } = await c.req.json<{ enabled?: boolean }>()
    if (typeof enabled !== 'boolean') return c.json({ error: 'Expected a boolean.' }, 400)
    accounts().setAutomatic(enabled)
    return c.json({ success: true })
  })
  router.post('/:id/workspaces/:workspace/select', async c => {
    await accounts().select(c.req.param('id'), c.req.param('workspace'))
    return c.json({ success: true })
  })
  router.post('/:id/reset', async c => {
    const { email, workspaceId, idempotencyKey, creditId } = z.object({
      email: z.string().nullable(), workspaceId: z.string().nullable(),
      idempotencyKey: z.string().uuid(), creditId: z.string().min(1).optional(),
    }).parse(await c.req.json())
    return c.json(await accounts().redeemReset({
      accountId: c.req.param('id'), expectedIdentity: { email, workspaceId }, idempotencyKey, creditId,
    }))
  })
  router.post('/:id/select', async c => { await accounts().select(c.req.param('id')); return c.json({ success: true }) })
  router.delete('/:id', async c => { await accounts().remove(c.req.param('id')); return c.json({ success: true }) })
  return router
}
