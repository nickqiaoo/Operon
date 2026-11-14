import { Hono, type Context } from 'hono'
import { disbandTeam, rosterAll } from '../services/operon-runtime/peers.js'
import { getOperonHarness } from '../services/operon-runtime/index.js'

/**
 * Teams (peers) API — session-independent. The roster spans the whole harness. Its settings
 * (budget, teammate types) are the extension's own, edited like any extension's
 * (`/api/extensions/peers/settings`); on/off is its load / unload (`/api/extensions/*`).
 */
export function peersRoutes() {
  const router = new Hono()

  const fail = (c: Context, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ error: message }, 500)
  }

  router.get('/roster', async (c) => {
    try {
      await getOperonHarness()
      return c.json(await rosterAll())
    } catch (error) {
      return fail(c, error)
    }
  })

  router.post('/disband', async (c) => {
    try {
      const { label } = await c.req.json<{ label?: string }>()
      if (!label) return c.json({ error: 'label is required' }, 400)
      await getOperonHarness()
      return c.json(await disbandTeam(label))
    } catch (error) {
      return fail(c, error)
    }
  })

  return router
}
