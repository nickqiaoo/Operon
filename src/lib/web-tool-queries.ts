import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { KeyedProvider, WebToolUpdate } from '@shared/web-tools'
import { api } from './api'

/** Operon's web search / page reading providers (Settings → Operon → Web tools). */
export const webToolKeys = {
  all: ['settings', 'operon-web-tools'] as const,
  settings: () => [...webToolKeys.all, 'settings'] as const,
  key: (provider: KeyedProvider) => [...webToolKeys.all, 'key', provider] as const,
}

export function useWebToolSettings() {
  return useQuery({ queryKey: webToolKeys.settings(), queryFn: () => api.getWebToolSettings() })
}

/** The saved API key of `provider`, read only while it is being edited and never kept afterwards. */
export function useWebToolKey(provider: KeyedProvider | undefined, enabled: boolean) {
  return useQuery({
    queryKey: webToolKeys.key(provider ?? 'tavily'),
    queryFn: () => api.getWebToolKey(provider!),
    enabled: enabled && provider !== undefined,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })
}

export function useSaveWebToolSettings() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (update: WebToolUpdate) => api.saveWebToolSettings(update),
    onSuccess: (settings) => {
      client.setQueryData(webToolKeys.settings(), settings)
      client.removeQueries({ queryKey: [...webToolKeys.all, 'key'] })
    },
  })
}
