import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import type { OperonMarketplaceDetailsDTO, OperonMarketplaceEntryDTO } from '@/types/plugin'
import { api } from './api'
import { queryClient } from './query-client'
import { providerKeys } from './provider-queries'
import { settingsKeys } from './settings-queries'
import { skillKeys } from './skill-queries'

/**
 * TanStack Query layer for the plugin marketplace page: the installed store, the
 * configured registries' entries, their logos/descriptions (fetched in chunks so
 * they appear progressively), and one plugin's detail.
 */

export const pluginKeys = {
  all: ['plugins'] as const,
  installed: () => ['plugins', 'installed'] as const,
  marketplace: () => ['plugins', 'marketplace'] as const,
  detailsAll: () => ['plugins', 'marketplace-details'] as const,
  details: (sources: readonly string[]) => ['plugins', 'marketplace-details', ...sources] as const,
  info: (id: string) => ['plugins', 'info', id] as const,
  marketInfo: (source: string) => ['plugins', 'market-info', source] as const,
  mcpTools: (id: string, server: string) => ['plugins', 'mcp-tools', id, server] as const,
  skillContent: (origin: SkillOrigin, skill: string) =>
    ['plugins', 'skill-content', origin.kind, origin.kind === 'installed' ? origin.pluginId : origin.source, skill] as const,
}

/** Where a skill's SKILL.md is read from: an installed plugin's store, or a marketplace entry's cached repo. */
export type SkillOrigin = { kind: 'installed'; pluginId: string } | { kind: 'marketplace'; source: string }

/** The API answers errors in the body; turn them into query errors. */
function unwrap<T extends { error?: string }>(res: T): T {
  if (res.error) throw new Error(res.error)
  return res
}

const DETAILS_CHUNK = 24
// Registry entries and their decoration change rarely; refresh is explicit.
const MARKETPLACE_STALE_MS = 10 * 60_000

export function useInstalledPlugins({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: pluginKeys.installed(),
    queryFn: async () => unwrap(await api.pluginsList()).plugins ?? [],
    enabled,
    retry: false,
  })
}

export function useMarketplace() {
  return useQuery({
    queryKey: pluginKeys.marketplace(),
    queryFn: async () => unwrap(await api.pluginsMarketplace()),
    staleTime: MARKETPLACE_STALE_MS,
    retry: false,
  })
}

/**
 * Logos and descriptions for marketplace entries, one query per chunk of 24 so
 * they land progressively. Best-effort: a failed chunk just renders without
 * decoration.
 */
export function useMarketplaceDetails(entries: readonly OperonMarketplaceEntryDTO[] | null) {
  const chunks = useMemo(() => {
    const list = entries ?? []
    const out: string[][] = []
    for (let i = 0; i < list.length; i += DETAILS_CHUNK) out.push(list.slice(i, i + DETAILS_CHUNK).map((e) => e.source))
    return out
  }, [entries])

  return useQueries({
    queries: chunks.map((sources) => ({
      queryKey: pluginKeys.details(sources),
      queryFn: async () => {
        const res = await api.pluginsMarketplaceDetails(sources)
        // Cached-repo logos come as a local path — resolve to a servable asset URL for <img>.
        const normalized: Record<string, OperonMarketplaceDetailsDTO> = {}
        for (const [src, d] of Object.entries(res.details ?? {})) {
          normalized[src] = d.logoAsset && !d.logoUrl ? { ...d, logoUrl: await api.pluginAssetUrl(d.logoAsset) } : d
        }
        return normalized
      },
      staleTime: MARKETPLACE_STALE_MS,
      retry: false,
    })),
    combine: mergeDetails,
  })
}

// Module-level so TanStack memoizes the merged map between renders.
function mergeDetails(results: Array<{ data?: Record<string, OperonMarketplaceDetailsDTO> }>) {
  const merged: Record<string, OperonMarketplaceDetailsDTO> = {}
  for (const r of results) if (r.data) Object.assign(merged, r.data)
  return merged
}

/** Re-browse the registries and re-read their decoration (the gallery's refresh). */
export function refreshMarketplace() {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: pluginKeys.marketplace() }),
    queryClient.invalidateQueries({ queryKey: pluginKeys.detailsAll() }),
  ])
}

/** An installed plugin's full detail (MCP servers with auth state, skills, apps). */
export function usePluginInfo(id: string, enabled: boolean) {
  return useQuery({
    queryKey: pluginKeys.info(id),
    queryFn: async () => (await api.pluginsInfo(id)).info ?? null,
    enabled,
    retry: false,
  })
}

/** A not-installed plugin's detail, read from the cached marketplace repo. */
export function useMarketplacePluginInfo(source: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: pluginKeys.marketInfo(source ?? ''),
    queryFn: async () => (await api.pluginsMarketplaceInfo(source!)).info ?? null,
    enabled: enabled && !!source,
    staleTime: MARKETPLACE_STALE_MS,
    retry: false,
  })
}

export function invalidatePluginInfo(id: string) {
  return queryClient.invalidateQueries({ queryKey: pluginKeys.info(id) })
}

/**
 * After installing, removing or toggling a plugin. Plugins add skills and MCP
 * servers to every agent, so besides the plugin lists this refreshes the MCP
 * settings' plugin group, the installed-skills lists and each provider's slash
 * command catalog.
 */
export function invalidateAfterPluginChange() {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: pluginKeys.installed() }),
    queryClient.invalidateQueries({ queryKey: ['plugins', 'info'] }),
    queryClient.invalidateQueries({ queryKey: settingsKeys.mcpPluginServers() }),
    queryClient.invalidateQueries({ queryKey: skillKeys.installedAll() }),
    queryClient.invalidateQueries({ queryKey: providerKeys.all }),
  ])
}

/** One MCP server's tools — read when its dialog opens, then kept for the session. */
export function usePluginMcpTools(pluginId: string, server: string, { enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: pluginKeys.mcpTools(pluginId, server),
    queryFn: async () => unwrap(await api.pluginsMcpTools(pluginId, server)).tools ?? [],
    enabled,
    staleTime: MARKETPLACE_STALE_MS,
    retry: false,
  })
}

/** A skill's SKILL.md — read when its dialog opens. */
export function usePluginSkillContent(origin: SkillOrigin, skill: string, { enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: pluginKeys.skillContent(origin, skill),
    queryFn: async () => {
      const res = origin.kind === 'installed'
        ? await api.pluginsSkill(origin.pluginId, skill)
        : await api.pluginsMarketplaceSkill(origin.source, skill)
      return unwrap(res).content ?? ''
    },
    enabled,
    staleTime: MARKETPLACE_STALE_MS,
    retry: false,
  })
}
