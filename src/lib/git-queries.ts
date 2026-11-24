import { useEffect } from 'react'
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import { apiOn, onNode, useChatNodeId, useChatTransport } from './chat-api-context'
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
  defaultBase: (root: string) => ['git', root, 'default-base'] as const,
  mergeBase: (root: string, ref: string) => ['git', root, 'merge-base', ref] as const,
  blob: (root: string, ref: string, path: string) => ['git', root, 'blob', ref, path] as const,
  changedFiles: (root: string, ref: string) => ['git', root, 'changed-files', ref] as const,
  prRepoStatus: (root: string) => ['git', root, 'pr-repo-status'] as const,
  prForBranch: (root: string, branch: string) => ['git', root, 'pr-for-branch', branch] as const,
  // One file's working-tree diff as the phone renders it; `variant` folds in the index/worktree codes.
  fileDiff: (root: string, path: string, variant: string) => ['git', root, 'file-diff', path, variant] as const,
  // Recent commits (newest first), for the commit pickers.
  commits: (root: string) => ['git', root, 'commits'] as const,
  // Local and remote branches, with the checked-out one flagged.
  branches: (root: string) => ['git', root, 'branches'] as const,
  // One commit's changed files with their patches (parent → commit), as the phone renders them.
  commitFiles: (root: string, sha: string) => ['git', root, 'commit-files', sha] as const,
  // The working tree's +N/-N against HEAD, for a sidebar workspace row.
  diffStat: (root: string) => ['git', root, 'diff-stat'] as const,
}

/**
 * Another machine's workspace row +N/-N (this machine's come from
 * `useWorkspaceDiffStats`, which reads every row at once). Working tree against
 * HEAD: what the agent changed and nobody committed yet. A worktree that is
 * gone or not a repo shows no count. `nodeId` undefined: disabled.
 */
export function useRemoteWorkspaceDiffStat(nodeId: string | undefined, root: string | undefined) {
  return useQuery({
    queryKey: onNode(gitKeys.diffStat(root ?? ''), nodeId),
    queryFn: async () => {
      try {
        const files = await apiOn(nodeId).gitDiffRange(root ?? '', 'HEAD', null)
        return files.reduce(
          (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
          { additions: 0, deletions: 0 },
        )
      } catch {
        return null
      }
    },
    enabled: !!nodeId && !!root,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })
}

/**
 * What to compare the working tree against by default: the repo's default base
 * branch (`origin/main`), unless it shares no history with HEAD — an archive
 * remote, a fork's unrelated upstream — or there is no remote at all; then
 * `HEAD`, i.e. the uncommitted changes.
 */
export async function resolveDefaultBase(
  root: string,
  /** The machine the repo lives on; this one by default. */
  client: Pick<typeof api, 'gitDefaultBaseBranch' | 'gitMergeBase'> = api,
): Promise<string> {
  const candidate = await client.gitDefaultBaseBranch(root)
  if (candidate != null && (await client.gitMergeBase(root, candidate)) != null) return candidate
  return 'HEAD'
}

export type GitStatus = Awaited<ReturnType<typeof api.gitStatus>>

/** Working-tree status summary (branch + staged/unstaged/untracked entries). */
export function useGitStatus(root: string, options?: { enabled?: boolean; refetchInterval?: number }) {
  // Inside a remote tab (the Session panel's git line) `root` is a path on that machine.
  const nodeId = useChatNodeId()
  return useQuery({
    queryKey: onNode(gitKeys.status(root), nodeId),
    queryFn: () => apiOn(nodeId).gitStatus(root),
    staleTime: FIVE_SECONDS,
    enabled: options?.enabled,
    refetchInterval: options?.refetchInterval,
  })
}

/**
 * Branches of the repo at `root` (local and remote); `current` marks what is
 * checked out there. `nodeId`: the repo is on another machine.
 */
export function gitBranchesQuery(root: string, nodeId?: string) {
  return queryOptions({
    queryKey: onNode(gitKeys.branches(root), nodeId),
    queryFn: () => apiOn(nodeId).gitBranches(root),
    staleTime: FIVE_SECONDS,
  })
}

export function useGitBranches(root: string, options?: { enabled?: boolean }) {
  const nodeId = useChatNodeId()
  return useQuery({
    queryKey: onNode(gitKeys.branches(root), nodeId),
    queryFn: () => apiOn(nodeId).gitBranches(root),
    staleTime: FIVE_SECONDS,
    enabled: options?.enabled,
  })
}

/** Recent commits on HEAD, newest first. */
export function useGitCommits(root: string, options?: { enabled?: boolean }) {
  const nodeId = useChatNodeId()
  return useQuery({
    queryKey: onNode(gitKeys.commits(root), nodeId),
    queryFn: () => apiOn(nodeId).gitCommits(root, 100),
    enabled: options?.enabled,
    staleTime: 30_000,
  })
}

export type PrRepoStatus = Awaited<ReturnType<typeof api.integrationGithubRepoStatus>>

/**
 * GitHub remote facts the commit / PR chrome needs: owner, repo, the default
 * branch and whether a token is configured. Lives under the `['git', root]`
 * prefix so committing or pushing refreshes it along with the diff.
 */
export function usePrRepoStatus(root: string) {
  const nodeId = useChatNodeId()
  return useQuery({
    queryKey: onNode(gitKeys.prRepoStatus(root), nodeId),
    queryFn: () => apiOn(nodeId).integrationGithubRepoStatus(root),
    staleTime: FIVE_SECONDS,
  })
}

/**
 * The open PR for the current branch. Separate from `usePrRepoStatus` because
 * it costs a network round-trip through `gh` — the status endpoint is polled on
 * every working-tree change and must stay local.
 */
export function usePrForBranch(root: string, branch: string | null, enabled: boolean) {
  const nodeId = useChatNodeId()
  return useQuery({
    queryKey: onNode(gitKeys.prForBranch(root, branch ?? ''), nodeId),
    queryFn: () => apiOn(nodeId).integrationGithubPrForBranch(root, branch ?? ''),
    enabled: enabled && !!branch,
    staleTime: 30_000,
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
  // The repo is on the machine of the view asking (the current workspace's).
  const transport = useChatTransport()

  useEffect(() => {
    if (root == null) return
    const watched = stripTrailingSlash(root)

    void watchRepo(root, transport)
    const unsubscribe = subscribe((event: GitRepoChangedEvent) => {
      if (stripTrailingSlash(event.root) !== watched) return
      // Prefix match: reaches that machine's entries (`onNode` appends the machine).
      void queryClient.invalidateQueries({ queryKey: gitKeys.all(root) })
    }, transport)

    return () => {
      unsubscribe()
      void unwatchRepo(root, transport)
    }
  }, [root, queryClient, transport])
}
