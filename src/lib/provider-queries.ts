import { useMemo } from 'react'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { api } from './api'
import { queryClient } from './query-client'

/**
 * TanStack Query layer for the agent providers (`/ai/providers`) and each
 * provider's model / mode / capability catalog (`/ai/providers/:id/models`).
 *
 * Both used to be fetched by every surface that needed them — each open chat
 * tab, the new-tab menu, settings, the cron and canvas pages — with a
 * hand-rolled listener set for invalidation and a module-level promise as a
 * makeshift cache. One cache entry per key now serves all of them: a new tab
 * reads its provider's models synchronously instead of flashing an empty
 * picker, and a settings save refreshes every consumer through
 * `invalidateProviderQueries()`.
 */

export type ProviderSummary = Awaited<ReturnType<typeof api.getProviders>>[number]

type ProviderConfigCategory = 'model' | 'mode' | 'thought_level' | 'service_tier'

export interface ProviderConfigOptionResponse {
  category: ProviderConfigCategory
  currentValue?: string
  options: Array<{
    value: string
    name: string
    description?: string
    providerLogo?: string
    providerLabel?: string
    supportedEffortLevels?: string[]
    supportsAutoMode?: boolean
    supportsFastMode?: boolean
    supportsAdaptiveThinking?: boolean
  }>
}

export interface ProviderModelsResponse {
  models?: Array<{
    id?: string
    modelId?: string
    name: string
    providerLogo?: string
    providerLabel?: string
  }>
  currentModelId?: string
  modes?: Array<{ id: string; name: string; description?: string }>
  currentModeId?: string
  serviceTiers?: Array<{ id: string; name: string; description?: string }>
  currentServiceTier?: string
  commands?: Array<{ id: string; name: string; description?: string }>
  skills?: Array<{ name: string; description?: string }>
  slashCommands?: Array<{ name: string; description?: string; type?: 'skill' | 'command' }>
  features?: {
    injection?: boolean
    goal?: boolean
    dynamicSwitch?: boolean
    contextUsage?: boolean
    sideChat?: boolean
  }
  configOptions?: ProviderConfigOptionResponse[]
  // Set by the backend SWR cache when the provider's model list isn't ready yet
  // (e.g. copilot's background probe is still running). We poll until it clears.
  modelsPending?: boolean
}

export const providerKeys = {
  all: ['providers'] as const,
  list: () => ['providers', 'list'] as const,
  models: (providerId: string) => ['providers', 'models', providerId] as const,
}

// Availability flips when a CLI is installed or a key is saved; the save paths
// invalidate explicitly, so this only bounds how stale a quiet tab can get.
const THIRTY_SECONDS = 30_000

// How the frontend backs off while a provider is still warming up. copilot's
// probe takes ~10-20s, so ~15 tries at 2s covers the cold-start window.
const MODELS_PENDING_POLL_MS = 2_000
const MODELS_PENDING_MAX_ATTEMPTS = 15

/** Shared by `useProviders` and imperative reads (`queryClient.fetchQuery`). */
export const providersQuery = queryOptions({
  queryKey: providerKeys.list(),
  queryFn: () => api.getProviders(),
  staleTime: THIRTY_SECONDS,
})

/** Every registered provider, available or not. Filter at the call site. */
export function useProviders(options?: { enabled?: boolean }) {
  return useQuery({ ...providersQuery, enabled: options?.enabled })
}

export function providerModelsQuery(providerId: string) {
  return queryOptions({
    queryKey: providerKeys.models(providerId),
    queryFn: async () => (await api.getProviderModels(providerId)) as ProviderModelsResponse,
    staleTime: THIRTY_SECONDS,
    refetchInterval: (query) => {
      const data = query.state.data
      const stillWarming =
        data?.modelsPending === true &&
        !data.configOptions?.some((c) => c.category === 'model' && c.options.length > 0) &&
        !data.models?.length
      return stillWarming && query.state.dataUpdateCount <= MODELS_PENDING_MAX_ATTEMPTS
        ? MODELS_PENDING_POLL_MS
        : false
    },
  })
}

/** One provider's model / mode / capability catalog. Disabled until `providerId` is known. */
export function useProviderModels(providerId: string | undefined) {
  return useQuery({
    ...providerModelsQuery(providerId ?? ''),
    enabled: !!providerId,
  })
}

const selectSideChat = (data: ProviderModelsResponse) => data.features?.sideChat === true

/**
 * Whether a provider can branch a session off another (what a side chat is
 * built on), read from its cached model catalog. Never fetches: a capability
 * question is always about an open conversation, and opening one loads its
 * provider's catalog.
 */
export function useProviderSupportsSideChat(providerId: string | undefined): boolean {
  const { data } = useQuery({ ...providerModelsQuery(providerId ?? ''), enabled: false, select: selectSideChat })
  return !!providerId && data === true
}

/** Non-reactive read of the same, for event handlers and store code. */
export function providerSupportsSideChat(providerId: string | undefined): boolean {
  if (providerId == null) return false
  return queryClient.getQueryData<ProviderModelsResponse>(providerKeys.models(providerId))?.features?.sideChat === true
}

export interface ProviderModelOption {
  modelId: string
  name: string
}

/**
 * The flat `models` list (id + name) the simple pickers show — settings seats,
 * spec seats. Null while loading, empty when the fetch failed or there is no
 * provider. Reads the same cache entry as `useProviderModels`.
 */
export function useProviderModelOptions(providerId: string | undefined): ProviderModelOption[] | null {
  const { data, isError } = useProviderModels(providerId)
  return useMemo(() => {
    if (!providerId || isError) return providerId ? [] : null
    if (!data) return null
    return (data.models ?? []).flatMap((m) => (m.modelId ? [{ modelId: m.modelId, name: m.name }] : []))
  }, [providerId, data, isError])
}

/**
 * Call whenever provider configs are saved, toggled or deleted: refreshes the
 * provider list and every provider's model catalog for all mounted consumers.
 */
export function invalidateProviderQueries() {
  return queryClient.invalidateQueries({ queryKey: providerKeys.all })
}
