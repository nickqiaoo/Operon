import { useCallback, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { DynamicModel } from './useModelManagement'

type ProviderInfo = {
  id: string
  label: string
  logo: string
}

type ProviderModelOption = {
  value: string
  name: string
  providerLogo?: string
  providerLabel?: string
}

type ProviderModelData = {
  models?: Array<{
    id?: string
    name: string
    providerLogo?: string
    providerLabel?: string
  }>
  configOptions?: Array<{
    category: string
    options?: ProviderModelOption[]
  }>
}

export function useSendToModels({
  providerId,
  availableModels,
}: {
  providerId?: string
  availableModels: DynamicModel[]
}) {
  const [globalAvailableModels, setGlobalAvailableModels] = useState<DynamicModel[] | null>(null)
  const globalModelsLoadedRef = useRef(false)

  const loadGlobalModels = useCallback(async () => {
    if (globalModelsLoadedRef.current || !providerId) return

    globalModelsLoadedRef.current = true
    try {
      const providers = await api.getProviders() as ProviderInfo[]
      const results = await Promise.all(
        providers.map(async (provider) => {
          try {
            return {
              provider,
              data: await api.getProviderModels(provider.id) as ProviderModelData,
            }
          } catch {
            return {
              provider,
              data: { models: [], configOptions: [] } satisfies ProviderModelData,
            }
          }
        }),
      )

      const models: DynamicModel[] = []
      for (const { provider, data } of results) {
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

      setGlobalAvailableModels(models)
    } catch (err) {
      console.error('Failed to load global models for SendTo:', err)
    }
  }, [providerId])

  return {
    sendToAvailableModels: providerId ? (globalAvailableModels ?? availableModels) : availableModels,
    loadGlobalModels,
  }
}
