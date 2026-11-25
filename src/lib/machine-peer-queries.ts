import { queryOptions, useQuery } from '@tanstack/react-query'
import { api } from './api'
import { getBaseUrlSync } from './api-client'

/** This machine's pairings with the account's other machines (Remote settings). */
export const machinePeerKeys = {
  all: ['machine-peers'] as const,
  peers: () => ['machine-peers', getBaseUrlSync(), 'peers'] as const,
  code: () => ['machine-peers', getBaseUrlSync(), 'code'] as const,
}

export const machinePeersQuery = () => queryOptions({
  queryKey: machinePeerKeys.peers(),
  queryFn: api.machinePeers,
  staleTime: 5_000,
  retry: false,
})

/** Refreshed now and then: a machine paired elsewhere in the group shows up here by itself. */
export function useMachinePeers() {
  return useQuery({ ...machinePeersQuery(), refetchInterval: 15_000 })
}

/** Whether the code this machine shows was used yet; polled while it is shown. */
export function useMachinePairingCodeStatus(shown: boolean) {
  return useQuery({
    queryKey: machinePeerKeys.code(),
    queryFn: api.machinePairingStatus,
    enabled: shown,
    refetchInterval: shown ? 1_000 : false,
    retry: false,
  })
}
