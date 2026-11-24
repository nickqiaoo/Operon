import { queryOptions, useQuery } from '@tanstack/react-query'
import { api } from './api'
import { getBaseUrlSync } from './api-client'
import { apiOn, onNode, useChatNodeId } from './chat-api-context'

/** Other machines of the account, and what this one accepts from them (Remote settings). */
export const delegationKeys = {
  all: ['delegations'] as const,
  // Scoped by backend: the web shell can switch which machine it talks to.
  machines: () => ['delegations', getBaseUrlSync(), 'machines'] as const,
  catalog: (nodeId: string) => ['delegations', getBaseUrlSync(), 'catalog', nodeId] as const,
  settings: () => ['delegations', getBaseUrlSync(), 'settings'] as const,
}

/**
 * The account's machines as `fromNodeId` sees them (`current` is that one).
 * Undefined: this machine.
 */
export const delegationMachinesQuery = (fromNodeId?: string) => queryOptions({
  queryKey: onNode(delegationKeys.machines(), fromNodeId),
  queryFn: () => apiOn(fromNodeId).delegationMachines(),
  staleTime: 10_000,
  retry: false,
})

/** Seen from the machine of the chat in scope; this machine outside a chat. */
export function useDelegationMachines(options?: { enabled?: boolean; refetchInterval?: number }) {
  const fromNodeId = useChatNodeId()
  return useQuery({ ...delegationMachinesQuery(fromNodeId), ...options })
}

/** A machine's agents and workspaces, asked through the chat's machine; disabled until one is chosen. */
export function useDelegationCatalog(nodeId: string | undefined) {
  const fromNodeId = useChatNodeId()
  return useQuery({
    queryKey: onNode(delegationKeys.catalog(nodeId ?? ''), fromNodeId),
    queryFn: () => apiOn(fromNodeId).delegationCatalog(nodeId!),
    enabled: !!nodeId,
    staleTime: 30_000,
    retry: false,
  })
}

export function useDelegationSettings() {
  return useQuery({ queryKey: delegationKeys.settings(), queryFn: api.delegationSettings, refetchInterval: 5_000, retry: false })
}
