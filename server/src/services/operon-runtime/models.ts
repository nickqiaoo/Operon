import type { Model } from '@operon/agent-runtime'
import { fetchProviderModels, getProviderConfigs, getProviderMeta, isProviderUsable, type ProviderConfig, type ProviderModel } from '../provider-config.js'
import { getModelCapabilities } from './resolve-model.js'

interface ProviderModelsEntry {
  configKey: string
  models: ProviderModel[]
  fetchedAt: number
  pending?: Promise<ProviderModel[]>
}

const FRESH_MS = 60_000
const providerModels = new Map<string, ProviderModelsEntry>()

/** Keep each endpoint's last successful list across aggregate catalog refreshes. */
function liveModels(providerId: string, config: ProviderConfig): Promise<ProviderModel[]> {
  // Manual models, labels and enabled state do not change the endpoint's live list.
  const configKey = JSON.stringify([config.apiKey, config.baseUrl, config.custom?.api])
  let entry = providerModels.get(providerId)
  if (!entry || entry.configKey !== configKey) {
    entry = { configKey, models: [], fetchedAt: -Infinity }
    providerModels.set(providerId, entry)
  }
  if (entry.pending) return entry.pending
  if (Date.now() - entry.fetchedAt < FRESH_MS) return Promise.resolve(entry.models)

  const current = entry
  current.pending = fetchProviderModels(providerId, config)
    .then((models) => {
      current.models = models
      return models
    })
    // A temporary network failure must not erase a configured provider's models.
    .catch(() => current.models)
    .finally(() => {
      current.fetchedAt = Date.now()
      current.pending = undefined
    })
  return current.pending
}

export async function availableModels(): Promise<Model[]> {
  const all = getProviderConfigs()
  for (const providerId of providerModels.keys()) {
    const config = all[providerId]
    if (!config?.enabled || !isProviderUsable(providerId, config)) providerModels.delete(providerId)
  }
  const groups = await Promise.all(
    Object.entries(all).map(async ([providerId, config]) => {
      if (!config.enabled || !isProviderUsable(providerId, config)) return []
      const results: Model[] = []
      const meta = getProviderMeta(providerId)
      const seen = new Set<string>()
      const push = (model: { id: string; name: string; description?: string }) => {
        const id = `${providerId}/${model.id}`
        if (seen.has(id)) return
        seen.add(id)
        results.push({
          ...model,
          id,
          providerId,
          providerLabel: meta.label,
          // `custom` is Operon's own agent; a user-added provider draws a generic endpoint.
          providerLogo: config.custom ? 'endpoint' : providerId,
          supportedEffortLevels: getModelCapabilities(id).effortLevels,
        })
      }
      // Hand-entered model IDs first — these must show even when the provider has
      // no "list models" endpoint (or the live fetch below fails).
      for (const id of config.manualModels ?? []) push({ id, name: id })
      const models = await liveModels(providerId, config)
      for (const model of models) push(model)
      return results
    }),
  )
  return groups.flat()
}

