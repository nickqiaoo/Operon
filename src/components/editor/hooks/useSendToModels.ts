import { useCallback, useMemo, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import {
  providerModelsQuery,
  useProviders,
  type ProviderModelsResponse,
  type ProviderSummary,
} from '@/lib/provider-queries'
import type { DynamicModel } from './useModelManagement'

/** Every provider's models flattened into one list; a provider with no model list becomes one entry. */
function flattenModels(entries: Array<{ provider: ProviderSummary; data: ProviderModelsResponse }>): DynamicModel[] {
  const models: DynamicModel[] = []
  for (const { provider, data } of entries) {
    const modelConfigOpt = data.configOptions?.find((config) => config.category === 'model')

    if (modelConfigOpt?.options?.length) {
      for (const option of modelConfigOpt.options) {
        models.push({
          id: option.value,
          label: option.name,
          providerId: provider.id,
          provider: option.providerLogo ?? provider.logo,
          group: option.providerLabel ?? provider.label,
          hasThinking: false,
        })
      }
      continue
    }

    if (data.models?.length) {
      for (const model of data.models) {
        const modelId = model.id
        if (!modelId) continue
        models.push({
          id: modelId,
          label: model.name,
          providerId: provider.id,
          provider: model.providerLogo ?? provider.logo,
          group: model.providerLabel ?? provider.label,
          hasThinking: false,
        })
      }
      continue
    }

    models.push({
      id: provider.id,
      label: provider.label,
      providerId: provider.id,
      provider: provider.logo,
      group: provider.label,
      hasThinking: false,
    })
  }
  return models
}

const NO_PROVIDERS: ProviderSummary[] = []
const EMPTY_MODELS: ProviderModelsResponse = {}

// Module-level so TanStack can memoize the combined result: ChatPanel re-renders on every token.
function combineProviderModels(
  results: Array<{ data?: ProviderModelsResponse; isPending: boolean; fetchStatus: string }>,
): ProviderModelsResponse[] | null {
  return results.some((r) => r.isPending && r.fetchStatus !== 'idle')
    ? null
    : results.map((r) => r.data ?? EMPTY_MODELS)
}

export function useSendToModels({
  providerId,
  availableModels,
}: {
  providerId?: string
  availableModels: DynamicModel[]
}) {
  // Nothing is fetched until the Send-to menu first opens (loadGlobalModels).
  const [requested, setRequested] = useState(false)
  const enabled = requested && !!providerId
  const providers = useProviders({ enabled }).data ?? NO_PROVIDERS

  // One query per provider — the same cache entries the chat panels read. Null
  // until every provider has answered (a failed one counts as an empty list).
  const perProvider = useQueries({
    queries: providers.map((provider) => ({ ...providerModelsQuery(provider.id), enabled })),
    combine: combineProviderModels,
  })

  const globalAvailableModels = useMemo(
    () =>
      enabled && providers.length > 0 && perProvider
        ? flattenModels(providers.map((provider, i) => ({ provider, data: perProvider[i] ?? EMPTY_MODELS })))
        : null,
    [enabled, providers, perProvider],
  )

  const loadGlobalModels = useCallback(() => setRequested(true), [])

  return {
    sendToAvailableModels: providerId ? (globalAvailableModels ?? availableModels) : availableModels,
    loadGlobalModels,
  }
}
