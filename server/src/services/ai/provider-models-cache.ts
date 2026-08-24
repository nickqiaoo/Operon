import { buildProviderModelsResult, type ProviderModelsResult } from './provider-config.js'
import {
  getProviderBaseDescriptor,
  getProviderDescriptorPatch,
} from './helpers.js'

interface ProviderModelsCacheEntry {
  result: ProviderModelsResult
  fetchedAt: number
  ready: boolean
}

interface ProviderModelsRefresh {
  generation: number
  promise: Promise<void>
}

const FRESH_MS = 60_000

const cache = new Map<string, ProviderModelsCacheEntry>()
const inflight = new Map<string, ProviderModelsRefresh>()
const generations = new Map<string, number>()

const getGeneration = (providerId: string): number => generations.get(providerId) ?? 0

async function fetchAndStore(providerId: string, generation: number): Promise<void> {
  const descriptor = await getProviderBaseDescriptor(providerId)
  const result = buildProviderModelsResult(descriptor)
  if (getGeneration(providerId) !== generation) return

  cache.set(providerId, {
    result,
    fetchedAt: Date.now(),
    ready: result.modelsPending !== true,
  })
}

function refreshProviderModels(providerId: string): Promise<void> {
  const generation = getGeneration(providerId)
  const current = inflight.get(providerId)
  if (current?.generation === generation) return current.promise

  const refresh = fetchAndStore(providerId, generation).finally(() => {
    if (inflight.get(providerId)?.promise === refresh) {
      inflight.delete(providerId)
    }
  })
  inflight.set(providerId, { generation, promise: refresh })
  return refresh
}

function withDynamicState(
  providerId: string,
  entry: ProviderModelsCacheEntry,
): ProviderModelsResult {
  const base = entry.ready
    ? entry.result
    : { ...entry.result, modelsPending: true }
  const patch = getProviderDescriptorPatch(providerId)
  if (!patch) return base

  const configOptions = base.configOptions.map((option) => {
    if (option.category === 'model' && patch.currentModelId !== undefined) {
      return { ...option, currentValue: patch.currentModelId }
    }
    if (option.category === 'mode' && patch.currentModeId !== undefined) {
      return { ...option, currentValue: patch.currentModeId }
    }
    if (option.category === 'thought_level' && patch.currentThinkingLevel !== undefined) {
      return { ...option, currentValue: patch.currentThinkingLevel }
    }
    if (option.category === 'service_tier' && patch.currentServiceTier !== undefined) {
      return { ...option, currentValue: patch.currentServiceTier }
    }
    return option
  })

  return {
    ...base,
    ...(patch.currentModelId !== undefined ? { currentModelId: patch.currentModelId } : {}),
    ...(patch.currentModeId !== undefined ? { currentModeId: patch.currentModeId } : {}),
    ...(patch.currentServiceTier !== undefined
      ? { currentServiceTier: patch.currentServiceTier }
      : {}),
    ...(patch.slashCommands !== undefined ? { slashCommands: patch.slashCommands } : {}),
    configOptions,
  }
}

export async function getProviderModelsCached(providerId: string): Promise<ProviderModelsResult> {
  const entry = cache.get(providerId)
  if (entry) {
    const stale = Date.now() - entry.fetchedAt > FRESH_MS
    if (!entry.ready || stale) {
      void refreshProviderModels(providerId).catch((error: unknown) => {
        console.warn(
          `[AI] Failed to refresh models for ${providerId}:`,
          error instanceof Error ? error.message : String(error),
        )
      })
    }
    return withDynamicState(providerId, entry)
  }

  await refreshProviderModels(providerId)
  const fresh = cache.get(providerId)
  if (!fresh) {
    // The provider may have been invalidated while its cold request was in
    // flight. Retry against the new generation instead of returning stale data.
    return getProviderModelsCached(providerId)
  }
  return withDynamicState(providerId, fresh)
}

export async function warmAllProviders(providerIds: string[]): Promise<void> {
  await Promise.allSettled(providerIds.map((providerId) => refreshProviderModels(providerId)))
}

export function invalidateProviderModels(providerId?: string): void {
  if (providerId) {
    generations.set(providerId, getGeneration(providerId) + 1)
    cache.delete(providerId)
    return
  }

  const providerIds = new Set([...cache.keys(), ...inflight.keys()])
  for (const id of providerIds) {
    generations.set(id, getGeneration(id) + 1)
  }
  cache.clear()
}
