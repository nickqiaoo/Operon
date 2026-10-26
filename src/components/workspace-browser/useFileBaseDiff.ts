import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs"
import type { GitStatusEntry } from "@pierre/trees"
import { api } from "@/lib/api"
import { gitKeys, resolveDefaultBase } from "@/lib/git-queries"
import { PIERRE_GIT_STATUS } from "@/components/app-shell/content/review/constants"
import { isUntracked } from "@/components/app-shell/content/review/diff-utils"
import { useFilePreviewDiffStore } from "@/stores/file-preview-diff-store"

/** Past this, either side is too big to diff on the main thread (Codex's cap). */
const MAX_DIFF_CHARS = 2 * 1024 * 1024

export interface DiffBase {
  /** What the file is compared against (`origin/main`, `HEAD`, a branch). Null until resolved. */
  base: string | null
  /** `merge-base(base, HEAD)` — the commit the old side is read at. */
  mergeBase: string | null
  /** False once the root turns out not to be a git repo with commits. */
  available: boolean
}

/**
 * The comparison base for a workspace: the one picked in the preview, else the
 * repo's default base branch (`origin/main`), else `HEAD` when there's no
 * remote. Resolved to a merge-base like the Review tab's branch scope, so both
 * show the same changes.
 */
export function useDiffBase(rootPath: string | null | undefined, enabled: boolean): DiffBase {
  const root = rootPath ?? ""
  const remembered = useFilePreviewDiffStore((s) => (rootPath ? s.baseByRoot[rootPath] : undefined))
  // Same key as `mergeQuery` below once it settles on this base, so no extra request.
  const rememberedQuery = useQuery({
    queryKey: gitKeys.mergeBase(root, remembered ?? ""),
    queryFn: () => api.gitMergeBase(root, remembered ?? ""),
    enabled: enabled && root !== "" && remembered != null,
    staleTime: 5_000,
  })
  // A picked base that no longer shares history with HEAD (deleted, or the
  // history was rewritten) falls back to the default. Otherwise the diff toggle
  // and the base pill both hide, leaving no way to pick another one.
  const rememberedStale =
    rememberedQuery.isError || (rememberedQuery.isSuccess && rememberedQuery.data == null)
  const chosen = rememberedStale ? undefined : remembered
  const defaultQuery = useQuery({
    queryKey: gitKeys.defaultBase(root),
    queryFn: () => resolveDefaultBase(root),
    enabled: enabled && root !== "" && chosen == null,
    staleTime: 60_000,
  })
  const base = chosen ?? (defaultQuery.isSuccess ? defaultQuery.data : defaultQuery.isError ? "HEAD" : null)
  const mergeQuery = useQuery({
    queryKey: gitKeys.mergeBase(root, base ?? ""),
    queryFn: () => api.gitMergeBase(root, base ?? ""),
    enabled: enabled && root !== "" && base != null,
    staleTime: 5_000,
  })
  return {
    base,
    mergeBase: mergeQuery.data ?? null,
    available: !mergeQuery.isError && !(mergeQuery.isSuccess && mergeQuery.data == null),
  }
}

/**
 * Files that differ from the comparison base, as the file tree's git badges
 * (M / A / U on the file, a dot on every folder above it). The same set gates
 * the preview's diff, so a file marked in the tree always opens with its
 * changes and an unmarked one opens plain. Null until both lists load.
 *
 * Two cheap git calls, no patches: `git diff --name-status <merge-base>` for
 * tracked changes and `git status` for untracked files (the range diff skips
 * them). Gitignored files appear in neither, so they never read as new.
 * Paths are repo-root relative, which is the workspace root.
 */
export function useChangedFiles(
  rootPath: string | null | undefined,
  enabled: boolean
): GitStatusEntry[] | null {
  const root = rootPath ?? ""
  const active = enabled && root !== ""
  const { mergeBase } = useDiffBase(rootPath, active)
  const rangeQuery = useQuery({
    queryKey: gitKeys.changedFiles(root, mergeBase ?? ""),
    queryFn: () => api.gitDiffRange(root, mergeBase ?? "", null),
    enabled: active && mergeBase != null,
    staleTime: 5_000,
  })
  // Same key as `useGitStatus`, so it shares that cache; gated so previews
  // without git badges (mobile, assistant) never run `git status`.
  const statusQuery = useQuery({
    queryKey: gitKeys.status(root),
    queryFn: () => api.gitStatus(root),
    enabled: active,
    staleTime: 5_000,
  })
  const range = rangeQuery.data
  const status = statusQuery.data
  return useMemo(() => {
    if (range == null || status == null) return null
    const entries: GitStatusEntry[] = range.map((file) => ({
      path: file.path,
      status: PIERRE_GIT_STATUS[file.status.charAt(0)] ?? "modified",
    }))
    const seen = new Set(entries.map((entry) => entry.path))
    for (const file of [...status.untracked, ...status.unstaged.filter(isUntracked)]) {
      if (seen.has(file.path)) continue
      seen.add(file.path)
      entries.push({ path: file.path, status: "untracked" })
    }
    return entries
  }, [range, status])
}

/** One changed block, by the 1-based line its first rendered row carries. */
export interface DiffChange {
  /** First removed line (old file numbering); null for a pure addition. */
  deletionLine: number | null
  /** First added line (new file numbering); null for a pure deletion. */
  additionLine: number | null
}

export type FileBaseDiff =
  | { status: "off" }
  | { status: "loading" }
  /** Same as the base (or gitignored): the file reads plain. */
  | { status: "unchanged" }
  | { status: "too-large" }
  | { status: "ready"; fileDiff: FileDiffMetadata; changes: DiffChange[] }

/**
 * Diff the previewed file's current contents against the comparison base,
 * computed here from the two blobs (like Codex) so the whole file renders with
 * the changed lines marked in place.
 */
export function useFileBaseDiff({
  rootPath,
  relativePath,
  contents,
  enabled,
}: {
  rootPath: string | null | undefined
  /** Path relative to `rootPath`; null when the file sits outside it. */
  relativePath: string | null
  /** Current contents, null while loading. */
  contents: string | null
  enabled: boolean
}): { base: DiffBase; diff: FileBaseDiff } {
  const root = rootPath ?? ""
  const changedFiles = useChangedFiles(rootPath, enabled && relativePath != null)
  const changed =
    changedFiles != null && relativePath != null && changedFiles.some((f) => f.path === relativePath)
  const active = enabled && root !== "" && relativePath != null
  const base = useDiffBase(rootPath, active)
  const mergeBase = base.mergeBase
  const blobQuery = useQuery({
    queryKey: gitKeys.blob(root, mergeBase ?? "", relativePath ?? ""),
    // `./` makes the path relative to the root rather than the repo top level,
    // which differ when the workspace is a subfolder. Empty = not at that commit.
    queryFn: () => api.gitShow(root, mergeBase ?? "", `./${relativePath}`),
    enabled: active && changed && mergeBase != null,
    staleTime: Infinity,
  })
  const oldText = blobQuery.data

  const diff = useMemo<FileBaseDiff>(() => {
    if (!active || !base.available) return { status: "off" }
    if (changedFiles == null) return { status: "loading" }
    // Not in the tree's changed set (unchanged, or gitignored): read it plain.
    if (!changed) return { status: "unchanged" }
    if (contents == null || oldText == null) return { status: "loading" }
    if (contents.length > MAX_DIFF_CHARS || oldText.length > MAX_DIFF_CHARS) {
      return { status: "too-large" }
    }
    const name = relativePath ?? ""
    let fileDiff: FileDiffMetadata
    try {
      fileDiff = parseDiffFromFile({ name, contents: oldText }, { name, contents })
    } catch {
      return { status: "too-large" }
    }
    const changes: DiffChange[] = []
    for (const hunk of fileDiff.hunks) {
      for (const block of hunk.hunkContent) {
        if (block.type !== "change") continue
        changes.push({
          deletionLine: block.deletions > 0 ? block.deletionLineIndex + 1 : null,
          additionLine: block.additions > 0 ? block.additionLineIndex + 1 : null,
        })
      }
    }
    return { status: "ready", fileDiff, changes }
  }, [active, base.available, changedFiles, changed, contents, oldText, relativePath])

  return { base, diff }
}
