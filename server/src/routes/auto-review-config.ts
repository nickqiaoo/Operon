import { Hono } from 'hono'
import { getAutoReviewConfig, setAutoReviewConfig } from '../services/auto-review-config.js'
import { listDecisionModels } from '../services/operon-runtime/resolve-model.js'

export function autoReviewConfigRoutes() {
  const router = new Hono()

  router.get('/', (c) => c.json(getAutoReviewConfig()))

  // Only Auto review can run these: they answer fixed questions and can't hold a conversation,
  // so they stay out of the provider model lists that feed the chat pickers.
  router.get('/decision-models', (c) => c.json({ models: listDecisionModels() }))

  router.put('/', async (c) => {
    const body = await c.req.json<{ modelId?: unknown }>()
    if (typeof body.modelId !== 'string') return c.json({ error: 'modelId must be a string' }, 400)
    setAutoReviewConfig({ modelId: body.modelId.trim() })
    return c.json(getAutoReviewConfig())
  })

  return router
}
