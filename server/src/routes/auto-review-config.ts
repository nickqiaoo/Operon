import { Hono } from 'hono'
import { getAutoReviewConfig, setAutoReviewConfig } from '../services/auto-review-config.js'

export function autoReviewConfigRoutes() {
  const router = new Hono()

  router.get('/', (c) => c.json(getAutoReviewConfig()))

  router.put('/', async (c) => {
    const body = await c.req.json<{ modelId?: unknown }>()
    if (typeof body.modelId !== 'string') return c.json({ error: 'modelId must be a string' }, 400)
    setAutoReviewConfig({ modelId: body.modelId.trim() })
    return c.json(getAutoReviewConfig())
  })

  return router
}
