import { queryOptions, useQuery } from '@tanstack/react-query'
import { api } from './api'
import { getBaseUrlSync } from './api-client'

/** Other machines of the account, and what this one accepts from them (Remote settings). */
export const delegationKeys = {
  all: ['delegations'] as const,
  // Scoped by backend: the web shell can switch which machine it talks to.
  machines: () => ['delegations', getBaseUrlSync(), 'machines'] as const,
  catalog: (nodeId: string) => ['delegations', getBaseUrlSync(), 'catalog', nodeId] as const,
  settings: () => ['delegations', getBaseUrlSync(), 'settings'] as const,
}

export const delegationMachinesQuery = () => queryOptions({
  queryKey: delegationKeys.machines(),
  queryFn: api.delegationMachines,
  staleTime: 10_000,
  retry: false,
})

export function useDelegationMachines(options?: { enabled?: boolean; refetchInterval?: number }) {
  return useQuery({ ...delegationMachinesQuery(), ...options })
}

/** A machine's agents and workspaces; disabled until one is chosen. */
export function useDelegationCatalog(nodeId: string | undefined) {
  return useQuery({
    queryKey: delegationKeys.catalog(nodeId ?? ''),
    queryFn: () => api.delegationCatalog(nodeId!),
    enabled: !!nodeId,
    staleTime: 30_000,
    retry: false,
  })
}

export function useDelegationSettings() {
  return useQuery({ queryKey: delegationKeys.settings(), queryFn: api.delegationSettings, refetchInterval: 5_000, retry: false })
}
