import { Hono, type Context } from 'hono'
import * as extensions from '../services/operon-runtime/extensions.js'
import { installMarketplaceExtension, listMarketplaceExtensions } from '../services/operon-runtime/extension-marketplace.js'

/**
 * File-extension management API — session-independent. Drives the operon harness's
 * `HarnessExtensionManager` (one per process). Settings → Operon → Extensions calls these;
 * the chat Agent panel reads the per-session view through the agent-control channel instead.
 */
export function extensionRoutes() {
  const router = new Hono()

  const fail = (c: Context, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ error: message }, 500)
  }

  router.get('/list', async (c) => {
    try {
      return c.json({ extensions: await extensions.listExtensions() })
    } catch (error) {
      return fail(c, error)
    }
  })

  router.get('/marketplace', async (c) => {
    try {
      return c.json(await listMarketplaceExtensions())
    } catch (error) {
      return fail(c, error)
    }
  })

  router.post('/marketplace/install', async (c) => {
    try {
      const { id } = await c.req.json<{ id?: string }>()
      if (!id) return c.json({ error: 'id is required' }, 400)
      return c.json({ extension: await installMarketplaceExtension(id) })
    } catch (error) {
      return fail(c, error)
    }
  })

  for (const [route, fn] of [
    ['/load', extensions.loadExtension],
    ['/reload', extensions.reloadExtension],
    ['/unload', extensions.unloadExtension],
    ['/remove', extensions.removeExtension],
  ] as const) {
    router.post(route, async (c) => {
      try {
        const { id } = await c.req.json<{ id?: string }>()
        if (!id) return c.json({ error: 'id is required' }, 400)
        await fn(id)
        return c.json({ ok: true })
      } catch (error) {
        return fail(c, error)
      }
    })
  }

  router.post('/install', async (c) => {
    try {
      const body = await c.req.json<extensions.InstallInput>()
      if (!body.url && !body.zipBase64) return c.json({ error: 'url or zipBase64 is required' }, 400)
      return c.json({ extension: await extensions.installExtension(body) })
    } catch (error) {
      return fail(c, error)
    }
  })

  return router
}
