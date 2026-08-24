import { Hono } from 'hono'
import {
  getProviderConfigs,
  getProviderConfig,
  setProviderConfig,
  fetchProviderModels,
  normalizeManualModels,
  PROVIDER_META,
} from '../services/provider-config.js'
import { invalidateProviderModels } from '../services/ai.js'

export function providerConfigRoutes() {
  const router = new Hono()

  const fetchModels = async (
    providerId: string,
    overrides?: { apiKey?: string; baseUrl?: string }
  ) => {
    const models = await fetchProviderModels(providerId, overrides)
    return { models }
  }

  // GET /api/provider-configs — return all configs with raw API keys
  router.get('/', (c) => {
    const configs = getProviderConfigs()
    const result: Record<string, { hasApiKey: boolean; apiKey?: string; baseUrl?: string; enabled: boolean; manualModels?: string[] }> = {}

    for (const providerId of Object.keys(PROVIDER_META)) {
      const cfg = configs[providerId] ?? {}
      result[providerId] = {
        hasApiKey: !!cfg.apiKey,
        apiKey: cfg.apiKey || undefined,
        baseUrl: cfg.baseUrl,
        enabled: cfg.enabled ?? false,
        manualModels: cfg.manualModels,
      }
    }
    return c.json({ configs: result })
  })

  // PUT /api/provider-configs/:providerId — save apiKey, baseUrl, and/or enabled
  router.put('/:providerId', async (c) => {
    const providerId = c.req.param('providerId')
    const body = await c.req.json<{ apiKey?: string; baseUrl?: string; enabled?: boolean; manualModels?: string[] }>()

    const existing = getProviderConfig(providerId)
    const updated = {
      apiKey: body.apiKey !== undefined
        ? (body.apiKey.trim() || undefined)
        : existing.apiKey,
      baseUrl: body.baseUrl !== undefined
        ? (body.baseUrl.trim() || undefined)
        : existing.baseUrl,
      enabled: body.enabled !== undefined ? body.enabled : (existing.enabled ?? false),
      manualModels: body.manualModels !== undefined
        ? normalizeManualModels(body.manualModels)
        : existing.manualModels,
    }
    setProviderConfig(providerId, updated)
    // Drop the cached descriptor so the model picker reflects the new config
    // (apiKey / baseUrl / manualModels / enabled) on next read.
    invalidateProviderModels(providerId)
    return c.json({ success: true })
  })

  // GET /api/provider-configs/:providerId/models — fetch live model list from saved config
  router.get('/:providerId/models', async (c) => {
    const providerId = c.req.param('providerId')
    try {
      return c.json(await fetchModels(providerId))
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Failed to fetch models' },
        400
      )
    }
  })

  // POST /api/provider-configs/:providerId/models — fetch using current unsaved form values
  router.post('/:providerId/models', async (c) => {
    const providerId = c.req.param('providerId')
    const body = await c.req.json<{ apiKey?: string; baseUrl?: string }>()
    try {
      return c.json(await fetchModels(providerId, body))
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Failed to fetch models' },
        400
      )
    }
  })

  return router
}
