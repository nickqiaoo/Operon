/**
 * Query keys for the workspace file tree. Mirrors Codex's
 * `workspace-directory-entries` query: one entry per directory, lazily fetched
 * on expand, with a short staleTime so re-accessing a directory re-reads it.
 *
 * Deliberately NOT wired to the git-repo-watcher — Codex's file tree refreshes
 * lazily (staleTime + re-expand) and via an explicit refresh, not live.
 */

export const WORKSPACE_DIR_STALE_MS = 5_000

export const workspaceDirKeys = {
  /** Prefix for every directory under a root — used to invalidate on refresh. */
  all: (root: string) => ['workspace-dir', root] as const,
  /** One directory's children. `treeDir` is the tree-relative path ("" = root). */
  dir: (root: string, treeDir: string) =>
    ['workspace-dir', root, treeDir] as const,
}
