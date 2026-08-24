import { Hono } from 'hono'
import {
  getEmbeddingConfig,
  updateEmbeddingConfig,
  generateEmbedding,
  SqliteVecStore,
  getLocalLLM,
} from '../services/vector/index.js'

export function embeddingConfigRoutes() {
  const router = new Hono()

  router.get('/config', (c) => {
    return c.json(getEmbeddingConfig())
  })

  router.put('/config', async (c) => {
    const body = await c.req.json()
    const prevConfig = getEmbeddingConfig()
    const updated = updateEmbeddingConfig(body)

    // Handle enable/disable transitions
    if (updated.enabled && !prevConfig.enabled) {
      // Enabling: init the vector store + start model download in background
      if (!SqliteVecStore.getInstance()) {
        SqliteVecStore.init()
      }
      const llm = getLocalLLM()
      llm.pullModels().catch((err) => {
        console.error('[Embedding] Model download failed:', err)
      })
    } else if (!updated.enabled && prevConfig.enabled) {
      const store = SqliteVecStore.getInstance()
      if (store) store.close()
    }

    return c.json(updated)
  })

  router.get('/status', async (c) => {
    try {
      const llm = getLocalLLM()
      const status = await llm.getStatus()
      return c.json(status)
    } catch (err) {
      return c.json({
        gpuType: false,
        gpuDevices: [],
        cpuCores: 0,
        models: {
          embed: { name: 'Qwen3-Embedding-0.6B', uri: '', downloaded: false, sizeBytes: 0 },
          rerank: { name: 'Qwen3-Reranker-0.6B', uri: '', downloaded: false, sizeBytes: 0 },
        },
        downloading: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  })

  router.post('/test', async (c) => {
    const { text } = await c.req.json<{ text?: string }>()
    const embedding = await generateEmbedding(text || 'Hello world')
    const dimensions = embedding?.length ?? 0

    // Auto-save detected dimensions and reinitialize vector store if changed
    if (embedding && dimensions > 0) {
      const current = getEmbeddingConfig()
      if (current.dimensions !== dimensions) {
        updateEmbeddingConfig({ dimensions })
        const store = SqliteVecStore.getInstance()
        if (store) {
          store.close()
          SqliteVecStore.init()
        }
      }
    }

    return c.json({
      success: embedding !== null,
      dimensions,
    })
  })

  router.post('/download', async (c) => {
    try {
      const llm = getLocalLLM()
      // Start download in background
      llm.pullModels().catch((err) => {
        console.error('[Embedding] Model download failed:', err)
      })
      return c.json({ started: true })
    } catch (err) {
      return c.json({ started: false, error: err instanceof Error ? err.message : 'Unknown error' }, 500)
    }
  })

  return router
}
