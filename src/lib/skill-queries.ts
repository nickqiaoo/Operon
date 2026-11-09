import { useQuery } from '@tanstack/react-query'
import type { SkillScope } from '@/types/skill'
import { skillsList } from '@/components/editor/agent/agentControl'
import { api } from './api'
import { queryClient } from './query-client'

/**
 * TanStack Query layer for Settings → Skills. Installed lists are keyed by
 * scope and project, so switching either never shows the previous list while
 * the next one loads.
 */

export const skillKeys = {
  all: ['skills'] as const,
  operon: (chatId: number | undefined) => ['skills', 'operon', chatId ?? null] as const,
  installedAll: () => ['skills', 'installed'] as const,
  installed: (scope: SkillScope, projectPath: string | undefined) =>
    ['skills', 'installed', scope, projectPath ?? ''] as const,
  available: (source: string) => ['skills', 'available', source] as const,
  detailAll: () => ['skills', 'detail'] as const,
  detail: (name: string, source: string, scope: SkillScope, workspacePath: string | undefined, installed: boolean) =>
    ['skills', 'detail', name, source, scope, workspacePath ?? '', installed] as const,
}

/** The API answers errors in the body; turn them into query errors. */
function unwrap<T extends { error?: string }>(res: T): T {
  if (res.error) throw new Error(res.error)
  return res
}

export function useInstalledSkills(scope: SkillScope, projectPath: string | undefined) {
  return useQuery({
    queryKey: skillKeys.installed(scope, projectPath),
    queryFn: async () => unwrap(await api.skillListInstalled(scope, projectPath)).skills ?? [],
    retry: false,
  })
}

export function useAvailableSkills(source: string) {
  return useQuery({
    queryKey: skillKeys.available(source),
    queryFn: async () => unwrap(await api.skillListAvailable(source)).skills ?? [],
    retry: false,
  })
}

/** Re-read a source past the server's cache (the toolbar's refresh). */
export async function refreshAvailableSkills(source: string) {
  await queryClient.fetchQuery({
    queryKey: skillKeys.available(source),
    queryFn: async () => unwrap(await api.skillListAvailable(source, true)).skills ?? [],
    staleTime: 0,
    retry: false,
  })
}

export function useSkillDetail(
  name: string,
  source: string,
  scope: SkillScope,
  workspacePath: string | undefined,
  installed: boolean,
) {
  return useQuery({
    queryKey: skillKeys.detail(name, source, scope, workspacePath, installed),
    queryFn: async () => unwrap(await api.skillDetail(name, source, scope, workspacePath)).detail ?? null,
    retry: false,
  })
}

/**
 * After an install / update / uninstall: every installed list (the shadow flags
 * depend on both scopes) and every detail preview (installed copy vs. source).
 */
export function invalidateInstalledSkills() {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: skillKeys.installedAll() }),
    queryClient.invalidateQueries({ queryKey: skillKeys.detailAll() }),
  ])
}

export function useOperonSkills(chatId: number | undefined, enabled: boolean) {
  return useQuery({
    queryKey: skillKeys.operon(chatId),
    queryFn: async () => (await skillsList(chatId!)).skills,
    enabled: chatId !== undefined && enabled,
    staleTime: Infinity,
    retry: false,
  })
}
