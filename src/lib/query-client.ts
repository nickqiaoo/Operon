import { QueryClient } from '@tanstack/react-query'

/**
 * Single app-wide QueryClient. Defaults mirror Codex's client: only a bounded
 * retry policy is set globally; everything else (staleTime, refetchOnWindowFocus)
 * is decided per query so each surface opts into its own freshness behaviour.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount) => failureCount < 3,
    },
  },
})
