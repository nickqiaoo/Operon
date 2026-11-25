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
  autoReview: () => ['settings', 'auto-review'] as const,
  memoryMaintenance: () => ['settings', 'memory-maintenance'] as const,
  memoryMaintenanceRuns: () => ['settings', 'memory-maintenance', 'runs'] as const,
  assistant: () => ['settings', 'assistant'] as const,
  env: () => ['settings', 'env'] as const,
  mcpServers: () => ['settings', 'mcp', 'servers'] as const,
  /** MCP servers enabled plugins contribute — changes when a plugin is toggled. */
  mcpPluginServers: () => ['settings', 'mcp', 'plugin-servers'] as const,
  diffPreview: () => ['settings', 'diff-preview'] as const,
  claudeToggles: () => ['settings', 'claude-toggles'] as const,
  cliAutoUpdate: () => ['settings', 'cli-auto-update'] as const,
  /** Where each agent CLI resolves to — one request covers every adapter. */
  cliPaths: () => ['settings', 'cli-paths'] as const,
  /** `<cli> --version` for one adapter; `resolvedPath` re-probes after the binary moves. */
  cliVersion: (adapterId: string, resolvedPath: string) =>
    ['settings', 'cli-paths', 'version', adapterId, resolvedPath] as const,
  specRoles: () => ['settings', 'spec-roles'] as const,
}

/** Operon's Claude Code switches; saving writes the server's answer back. */
export function useClaudeToggles() {
  return useQuery({
    queryKey: settingsKeys.claudeToggles(),
    queryFn: () => api.claudeTogglesGet(),
  })
}

export type CliPathInfo = Awaited<ReturnType<typeof api.cliPathsGet>>[string]

/** Every agent CLI's resolution (manual override / auto-detected / missing). */
export function useCliPaths() {
  return useQuery({
    queryKey: settingsKeys.cliPaths(),
    queryFn: () => api.cliPathsGet(),
  })
}

/**
 * Runs the CLI once to read its version. It spawns a process, so it only runs
 * for an adapter that resolved to a binary, and only for the one on screen.
 */
export function useCliVersion(adapterId: string, info: CliPathInfo | undefined) {
  const resolvedPath = info?.available ? info.resolvedPath ?? '' : ''
  return useQuery({
    queryKey: settingsKeys.cliVersion(adapterId, resolvedPath),
    queryFn: () => api.cliPathVersionProbe(adapterId),
    enabled: resolvedPath !== '',
    staleTime: 60_000,
  })
}

/** Daily CLI self-update state; polls while an update is running. */
export function useCliAutoUpdate() {
  return useQuery({
    queryKey: settingsKeys.cliAutoUpdate(),
    queryFn: () => api.cliAutoUpdateGet(),
    refetchInterval: (query) =>
      query.state.data && Object.values(query.state.data).some((s) => s.running) ? 2_000 : false,
  })
}

export function useAutoReviewConfig() {
  return useQuery({
    queryKey: settingsKeys.autoReview(),
    queryFn: () => api.autoReviewGetConfig(),
  })
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
