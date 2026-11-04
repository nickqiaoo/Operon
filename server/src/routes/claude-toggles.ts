import { Hono } from 'hono'
import type { ClaudeToggles } from '../../../shared/claude-toggles.js'
import { getClaudeToggles, setClaudeToggles } from '../services/claude-toggles.js'

export function claudeTogglesRoutes() {
  const router = new Hono()

  router.get('/', (c) => c.json(getClaudeToggles()))

  router.put('/', async (c) => {
    const body = await c.req.json<Partial<ClaudeToggles>>()
    return c.json(setClaudeToggles(body))
  })

  return router
}
