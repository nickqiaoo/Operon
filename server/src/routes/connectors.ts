import { Hono } from 'hono'
import { getConnectorDescriptor } from '../services/connectors/registry.js'

export function connectorRoutes() {
  const router = new Hono()

  router.get('/:id', async (c) => {
    try {
      const connector = await getConnectorDescriptor(c.req.param('id'))
      if (connector === undefined) return c.json({ error: 'not found' }, 404)
      return c.json({ connector })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return c.json({ error: message }, 500)
    }
  })

  return router
}
