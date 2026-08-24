import { Hono } from 'hono'
import {
  getCommitMessageConfig,
  setCommitMessageConfig,
} from '../services/commit-message-config.js'

export function commitMessageConfigRoutes() {
  const router = new Hono()

  router.get('/', (c) => {
    const config = getCommitMessageConfig()
    return c.json({ providerId: config.providerId, modelId: config.modelId })
  })

  router.put('/', async (c) => {
    const body = await c.req.json<{ providerId?: string; modelId?: string }>()
    setCommitMessageConfig({ providerId: body.providerId, modelId: body.modelId })
    const updated = getCommitMessageConfig()
    return c.json({ success: true, providerId: updated.providerId, modelId: updated.modelId })
  })

  return router
}
