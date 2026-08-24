import { Hono } from 'hono'
import { getEnvVars, setEnvVars } from '../services/env-config.js'

export function envRoutes() {
  const router = new Hono()

  // GET /api/env — return all user-defined env vars
  router.get('/', (c) => {
    return c.json({ vars: getEnvVars() })
  })

  // PUT /api/env — replace all user-defined env vars
  router.put('/', async (c) => {
    const body = await c.req.json<{ vars: Record<string, string> }>()
    setEnvVars(body.vars ?? {})
    return c.json({ success: true })
  })

  return router
}
