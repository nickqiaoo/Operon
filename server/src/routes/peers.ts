import { Hono, type Context } from 'hono'
import { loadPeersConfig, savePeersConfig } from '../services/operon-runtime/peers-config.js'
import { disbandTeam, reloadPeersExtension, rosterAll } from '../services/operon-runtime/peers.js'
import { getOperonHarness } from '../services/operon-runtime/index.js'

/**
 * Teams (peers) API — session-independent. The roster spans the whole harness; the
 * config (budget, teammate types) is applied by reloading the Teams extension. On/off is
 * the extension's own load / unload (`/api/extensions/*`).
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

  router.get('/config', async (c) => {
    try {
      return c.json({ config: await loadPeersConfig() })
    } catch (error) {
      return fail(c, error)
    }
  })

  router.post('/config', async (c) => {
    try {
      const body = await c.req.json<{ config?: unknown }>()
      const config = await savePeersConfig(body.config ?? body)
      await getOperonHarness()
      await reloadPeersExtension()
      return c.json({ config })
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
