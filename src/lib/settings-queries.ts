import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import { assistantApi } from './assistant-api'
import { queryClient } from './query-client'

/**
 * TanStack Query layer for the Settings tabs' saved configs. Each tab reads its
 * config with a hook from here and, after saving, writes the server's answer
 * back with `setSettingsData` (or invalidates), so reopening a tab shows the
 * saved state immediately instead of a spinner.
 *
 * Form drafts stay in component state; a draft is seeded from the query, never
 * the other way round.
 */

export const settingsKeys = {
  all: ['settings'] as const,
  commitMessage: () => ['settings', 'commit-message'] as const,
  memoryMaintenance: () => ['settings', 'memory-maintenance'] as const,
  memoryMaintenanceRuns: () => ['settings', 'memory-maintenance', 'runs'] as const,
  assistant: () => ['settings', 'assistant'] as const,
  env: () => ['settings', 'env'] as const,
  mcpServers: () => ['settings', 'mcp', 'servers'] as const,
  /** MCP servers enabled plugins contribute — changes when a plugin is toggled. */
  mcpPluginServers: () => ['settings', 'mcp', 'plugin-servers'] as const,
  diffPreview: () => ['settings', 'diff-preview'] as const,
  specRoles: () => ['settings', 'spec-roles'] as const,
}

export function useCommitMessageConfig() {
  return useQuery({
    queryKey: settingsKeys.commitMessage(),
    queryFn: () => api.commitMessageGetConfig(),
  })
}

export function useMemoryMaintenanceConfig() {
  return useQuery({
    queryKey: settingsKeys.memoryMaintenance(),
    queryFn: () => api.memoryMaintenanceGetConfig(),
  })
}

/** The latest 20 maintenance runs. */
export function useMemoryMaintenanceRuns() {
  return useQuery({
    queryKey: settingsKeys.memoryMaintenanceRuns(),
    queryFn: async () => {
      const list = await api.memoryMaintenanceListRuns(20)
      return Array.isArray(list) ? list : []
    },
  })
}

export function useAssistantConfig() {
  return useQuery({
    queryKey: settingsKeys.assistant(),
    queryFn: () => assistantApi.getConfig(),
  })
}

/** Environment variables applied to the server process. */
export function useEnvVars() {
  return useQuery({
    queryKey: settingsKeys.env(),
    queryFn: async () => (await api.envGetAll()).vars ?? {},
  })
}

/** User-configured MCP servers (mcp.json). */
export function useMcpServers() {
  return useQuery({
    queryKey: settingsKeys.mcpServers(),
    queryFn: async () => (await api.mcpGetServers()).servers ?? {},
  })
}

export function useMcpPluginServers() {
  return useQuery({
    queryKey: settingsKeys.mcpPluginServers(),
    queryFn: async () => (await api.mcpGetPluginServers()).servers ?? [],
  })
}

export function useDiffPreviewConfig() {
  return useQuery({
    queryKey: settingsKeys.diffPreview(),
    queryFn: () => api.diffPreviewGetConfig(),
  })
}

/** Default seats for spec roles, plus the providers that can fill them. */
export function useSpecRoleSettings() {
  return useQuery({
    queryKey: settingsKeys.specRoles(),
    queryFn: () => api.specGetRoleSettings(),
  })
}

/** Replace a cached settings entry with what the server returned from a save. */
export function setSettingsData<T>(key: readonly unknown[], data: T) {
  queryClient.setQueryData(key, data)
}
