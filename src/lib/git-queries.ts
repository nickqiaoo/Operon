import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import {
  subscribe,
  watchRepo,
  unwatchRepo,
  type GitRepoChangedEvent,
} from './git-repo-events'

/**
 * TanStack Query layer for git data, plus the central watcher → invalidation
 * bridge (Codex's model). Every git query lives under the `['git', root]` key
 * prefix so a single `invalidateQueries({ queryKey: ['git', root] })` refreshes
 * status, diffs and full-file blobs together when the repo changes on disk.
 */

const FIVE_SECONDS = 5_000

export type GitScope = 'unstaged' | 'staged' | 'commit' | 'branch' | 'lastTurn'

export const gitKeys = {
  all: (root: string) => ['git', root] as const,
  status: (root: string) => ['git', root, 'status'] as const,
  // `variant` discriminates range scopes (the chosen base branch / commit sha)
  // so switching base/commit doesn't read a stale cached diff.
  review: (root: string, scope: GitScope, variant = '') =>
    ['git', root, 'review', scope, variant] as const,
  fullFile: (root: string, scope: GitScope, path: string, variant = '') =>
    ['git', root, 'full-file', scope, path, variant] as const,
}

export type GitStatus = Awaited<ReturnType<typeof api.gitStatus>>

/** Working-tree status summary (branch + staged/unstaged/untracked entries). */
export function useGitStatus(root: string) {
  return useQuery({
    queryKey: gitKeys.status(root),
    queryFn: () => api.gitStatus(root),
    staleTime: FIVE_SECONDS,
  })
}

const stripTrailingSlash = (p: string) => p.replace(/[/\\]+$/, '')

/**
 * Subscribe a repo root to the git-repo-watcher and invalidate its queries when
 * the working tree / git internals change on disk. This is what makes external
 * `git commit`s (and edits made outside the app) show up without polling.
 *
 * We invalidate the whole `['git', root]` prefix for any change type — the
 * 500ms server-side debounce + 5s query staleTime keep this from thrashing, and
 * it sidesteps the per-type fan-out bookkeeping Codex needs for its many
 * branch/PR queries that we don't have.
 */
export function useGitRepoInvalidation(root: string | null): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (root == null) return
    const watched = stripTrailingSlash(root)

    void watchRepo(root)
    const unsubscribe = subscribe((event: GitRepoChangedEvent) => {
      if (stripTrailingSlash(event.root) !== watched) return
      void queryClient.invalidateQueries({ queryKey: gitKeys.all(root) })
    })

    return () => {
      unsubscribe()
      void unwatchRepo(root)
    }
  }, [root, queryClient])
}
