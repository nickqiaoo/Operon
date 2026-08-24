import { Hono } from 'hono'
import { getDiffPreviewConfig, setDiffPreviewConfig } from '../services/diff-preview-config.js'

export function diffPreviewConfigRoutes() {
  const router = new Hono()

  router.get('/', (c) => {
    const config = getDiffPreviewConfig()
    return c.json({
      workerUrl: config.workerUrl,
      workerApiKey: config.workerApiKey,
    })
  })

  router.put('/', async (c) => {
    const body = await c.req.json<{
      workerUrl?: string
      workerApiKey?: string
    }>()

    setDiffPreviewConfig({
      workerUrl: body.workerUrl,
      workerApiKey: body.workerApiKey,
    })

    const updated = getDiffPreviewConfig()
    return c.json({
      success: true,
      workerUrl: updated.workerUrl,
      workerApiKey: updated.workerApiKey,
    })
  })

  return router
}
