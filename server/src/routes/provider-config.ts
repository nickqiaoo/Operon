import { Hono } from 'hono'
import {
  getProviderConfigs,
  getProviderConfig,
  setProviderConfig,
  deleteProviderConfig,
  fetchProviderModels,
  normalizeManualModels,
  PROVIDER_META,
  type ProviderConfig,
} from '../services/provider-config.js'
import { invalidateProviderModels } from '../services/ai.js'
import { isCustomProviderApi, isCustomProviderId, type CustomProviderInfo } from '../../../shared/provider-config.js'

/** `{ name, api }` from a request body, or a message saying what is wrong with it. */
function parseCustom(value: unknown): CustomProviderInfo | string {
  const v = value as { name?: unknown; api?: unknown } | null
  const name = typeof v?.name === 'string' ? v.name.trim() : ''
  if (!name) return 'custom.name required'
  if (!isCustomProviderApi(v?.api)) return 'custom.api must be anthropic-messages, openai-completions or openai-responses'
  return { name, api: v.api }
}

export function providerConfigRoutes() {
  const router = new Hono()

  const fetchModels = async (
    providerId: string,
    overrides?: ProviderConfig
  ) => {
    const models = await fetchProviderModels(providerId, overrides)
    return { models }
  }

  // GET /api/provider-configs — return all configs with raw API keys
  router.get('/', (c) => {
    const configs = getProviderConfigs()
    const result: Record<string, { hasApiKey: boolean; apiKey?: string; baseUrl?: string; enabled: boolean; manualModels?: string[]; custom?: CustomProviderInfo }> = {}

    const customIds = Object.keys(configs).filter((id) => isCustomProviderId(id) && configs[id]?.custom)
    for (const providerId of [...Object.keys(PROVIDER_META), ...customIds]) {
      const cfg = configs[providerId] ?? {}
      result[providerId] = {
        hasApiKey: !!cfg.apiKey,
        apiKey: cfg.apiKey || undefined,
        baseUrl: cfg.baseUrl,
        enabled: cfg.enabled ?? false,
        manualModels: cfg.manualModels,
        custom: cfg.custom,
      }
    }
    return c.json({ configs: result })
  })

  // PUT /api/provider-configs/:providerId — save apiKey, baseUrl, and/or enabled
  router.put('/:providerId', async (c) => {
    const providerId = c.req.param('providerId')
    const body = await c.req.json<{ apiKey?: string; baseUrl?: string; enabled?: boolean; manualModels?: string[]; custom?: unknown }>()

    const existing = getProviderConfig(providerId)
    let custom = existing.custom
    if (isCustomProviderId(providerId)) {
      if (body.custom !== undefined || !custom) {
        const parsed = parseCustom(body.custom)
        if (typeof parsed === 'string') return c.json({ error: parsed }, 400)
        custom = parsed
      }
    } else if (body.custom !== undefined) {
      return c.json({ error: 'only custom-* providers take custom' }, 400)
    }
    const updated: ProviderConfig = {
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
      ...(custom ? { custom } : {}),
    }
    setProviderConfig(providerId, updated)
    // Drop the cached descriptor so the model picker reflects the new config
    // (apiKey / baseUrl / manualModels / enabled) on next read.
    invalidateProviderModels(providerId)
    return c.json({ success: true })
  })

  // DELETE /api/provider-configs/:providerId — remove a user-added provider (built-in ones only get turned off)
  router.delete('/:providerId', (c) => {
    const providerId = c.req.param('providerId')
    if (!isCustomProviderId(providerId)) return c.json({ error: 'only custom-* providers can be removed' }, 400)
    deleteProviderConfig(providerId)
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
    const body = await c.req.json<{ apiKey?: string; baseUrl?: string; custom?: unknown }>()
    // A custom provider being added has no saved config yet: its API comes with the form.
    let custom: CustomProviderInfo | undefined
    if (isCustomProviderId(providerId)) {
      const parsed = body.custom !== undefined ? parseCustom(body.custom) : getProviderConfig(providerId).custom
      if (typeof parsed === 'string' || !parsed) return c.json({ error: typeof parsed === 'string' ? parsed : 'custom required' }, 400)
      custom = parsed
    }
    try {
      return c.json(await fetchModels(providerId, { apiKey: body.apiKey, baseUrl: body.baseUrl, ...(custom ? { custom } : {}) }))
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Failed to fetch models' },
        400
      )
    }
  })

  return router
}
