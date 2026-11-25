import { queryOptions, useQuery } from '@tanstack/react-query'
import { api } from './api'
import { getBaseUrlSync } from './api-client'

/** Direct connections to paired machines over Tailscale (Remote settings). */
export const directLinkKeys = {
  all: ['direct-link'] as const,
  status: () => ['direct-link', getBaseUrlSync(), 'status'] as const,
}

export const directLinkStatusQuery = () => queryOptions({
  queryKey: directLinkKeys.status(),
  // Checks each machine's route, so the list says which way it goes now.
  queryFn: () => api.directLinkStatus(true),
  staleTime: 5_000,
  retry: false,
})

/** Refreshed now and then: Tailscale signs in or drops out on its own. */
export function useDirectLinkStatus() {
  return useQuery({ ...directLinkStatusQuery(), refetchInterval: 15_000 })
}
