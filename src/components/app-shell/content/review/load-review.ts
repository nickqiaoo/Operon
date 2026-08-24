import { api } from "@/lib/api"
import type { BranchInfo, DiffScope, FileChange, ReviewRefs } from "./types"
import { buildUntrackedDiff, countDiffMetrics, isUntracked, joinPath, mapEntryPatches } from "./diff-utils"

export async function loadRangeFiles(
  rootPath: string,
  baseRef: string,
  headRef: string | null,
): Promise<FileChange[]> {
  // One `git diff <base> [head]` returns every file's patch; split it locally
  // instead of a `git diff -- <path>` round-trip per file. `--name-status` /
  // `--numstat` (entries) still drive the authoritative path + line counts.
  const [entries, combined] = await Promise.all([
    api.gitDiffRange(rootPath, baseRef, headRef),
    api.gitFileDiffRange(rootPath, undefined, baseRef, headRef).catch(() => ""),
  ])
  const patchMap = await mapEntryPatches(entries, combined, (path) =>
    api.gitFileDiffRange(rootPath, path, baseRef, headRef),
  )
  const files = entries.map((entry) => {
    const diff = patchMap.get(entry.path) ?? ""
    const fromPatch = countDiffMetrics(diff)
    // Line counts: prefer `git diff --numstat` (what Codex sums for the
    // header). Patch parsing under-counts when a per-file `git diff` fails,
    // returns binary-only output, or drops rename/special paths.
    return {
      path: entry.path,
      status: entry.status,
      diff,
      additions: entry.additions ?? fromPatch.additions,
      deletions: entry.deletions ?? fromPatch.deletions,
      changedBytes: fromPatch.changedBytes,
      maxChangedLineBytes: fromPatch.maxChangedLineBytes,
    }
  })
  // Keep files that have a patch OR a non-zero numstat / non-M status so a
  // failed per-file diff cannot erase them from the +N/-N totals.
  return files.filter(
    (f) =>
      f.diff.length > 0 ||
      f.additions > 0 ||
      f.deletions > 0 ||
      f.status === "A" ||
      f.status === "D" ||
      f.status === "R" ||
      f.status === "C" ||
      f.status === "?",
  )
}

/**
 * Build the changed-file list + branch summary for a scope. Pure data load,
 * driven by a TanStack Query so the git-repo-watcher can invalidate it.
 *
 *   unstaged → unstaged + untracked     staged → index
 *   branch   → merge-base(base) → disk  commit → parent → commit
 */
export async function loadReview(
  rootPath: string,
  scope: DiffScope,
  opts: {
    baseBranch?: string | null
    commitSha?: string | null
    turnChatId?: number | null
    turnMessageUid?: string | null
  } = {},
): Promise<{ files: FileChange[]; branch: BranchInfo; refs: ReviewRefs }> {
  let status: Awaited<ReturnType<typeof api.gitStatus>>
  let diffStat: Awaited<ReturnType<typeof api.gitStatusWithDiffStat>>["diffStat"] | null = null
  if (scope === "unstaged" || scope === "staged") {
    const result = await api.gitStatusWithDiffStat(rootPath)
    status = result.status
    diffStat = result.diffStat
  } else {
    status = await api.gitStatus(rootPath)
  }
  const branch: BranchInfo = {
    current: status.current,
    ahead: status.ahead,
    behind: status.behind,
  }

  if (scope === "lastTurn") {
    // Diff the turn's start snapshot → its end snapshot, sourced from the
    // sidecar repo via a single AI rewind call (not the project git, and not
    // one request per file). Both ends are recorded, so this stays put as the
    // worktree moves on — it shows what the turn did, not what changed since.
    if (opts.turnChatId == null) return { files: [], branch, refs: { scope } }
    const turn = await api.aiGetTurnFileDiffs(
      opts.turnChatId,
      rootPath,
      opts.turnMessageUid ?? undefined,
    )
    const files = turn.files
      .map((f) => ({
        path: f.path,
        status: f.status,
        diff: f.diff,
        ...countDiffMetrics(f.diff),
      }))
      .filter((f) => f.diff.length > 0)
    return { files, branch, refs: { scope } }
  }

  if (scope === "branch") {
    if (!opts.baseBranch) return { files: [], branch, refs: { scope } }
    const mergeBase = await api.gitMergeBase(rootPath, opts.baseBranch)
    if (!mergeBase) return { files: [], branch, refs: { scope } }
    const files = await loadRangeFiles(rootPath, mergeBase, null)
    return { files, branch, refs: { scope, oldRef: mergeBase, newRef: null } }
  }

  if (scope === "commit") {
    if (!opts.commitSha) return { files: [], branch, refs: { scope } }
    const parent = await api.gitCommitParent(rootPath, opts.commitSha)
    const files = await loadRangeFiles(rootPath, parent, opts.commitSha)
    return {
      files,
      branch,
      refs: { scope, oldRef: parent, newRef: opts.commitSha },
    }
  }

  if (scope === "staged") {
    // Single `git diff --cached` for the whole index, split per file.
    const combined = await api.gitDiff(rootPath, undefined, true).catch(() => "")
    const patchMap = await mapEntryPatches(status.staged, combined, (path) =>
      api.gitDiff(rootPath, path, true),
    )
    const files: FileChange[] = status.staged
      .map((entry) => {
        const diff = patchMap.get(entry.path) ?? ""
        const fromPatch = countDiffMetrics(diff)
        const fromNumstat = diffStat?.staged[entry.path]
        return {
        path: entry.path,
        status: entry.status,
        diff,
          ...fromPatch,
          additions: fromNumstat?.additions ?? fromPatch.additions,
          deletions: fromNumstat?.deletions ?? fromPatch.deletions,
        }
      })
      .filter((f) => f.diff.length > 0)
    return { files, branch, refs: { scope } }
  }

  const unstagedEntries = status.unstaged.filter((e) => !isUntracked(e))
  const untrackedEntries = [...status.untracked, ...status.unstaged.filter(isUntracked)]

  // Single `git diff` covers all tracked working-tree changes; untracked files
  // aren't in `git diff` output, so they're still read individually from disk.
  const [combinedUnstaged, untrackedDiffs] = await Promise.all([
    api.gitDiff(rootPath).catch(() => ""),
    Promise.all(
      untrackedEntries.map(async (entry) => {
        try {
          const content = await api.readFile(joinPath(rootPath, entry.path))
          return { entry, diff: buildUntrackedDiff(entry.path, content) }
        } catch {
          return { entry, diff: "" }
        }
      }),
    ),
  ])
  const unstagedPatchMap = await mapEntryPatches(unstagedEntries, combinedUnstaged, (path) =>
    api.gitDiff(rootPath, path, false),
  )

  const files: FileChange[] = [
    ...unstagedEntries.map((entry) => {
      const diff = unstagedPatchMap.get(entry.path) ?? ""
      const fromPatch = countDiffMetrics(diff)
      const fromNumstat = diffStat?.unstaged[entry.path]
      return {
      path: entry.path,
      status: entry.status,
      diff,
        ...fromPatch,
        additions: fromNumstat?.additions ?? fromPatch.additions,
        deletions: fromNumstat?.deletions ?? fromPatch.deletions,
      }
    }),
    ...untrackedDiffs.map(({ entry, diff }) => {
      const fromPatch = countDiffMetrics(diff)
      const fromNumstat = diffStat?.unstaged[entry.path]
      return {
      path: entry.path,
      status: "?",
      diff,
        ...fromPatch,
        additions: fromNumstat?.additions ?? fromPatch.additions,
        deletions: fromNumstat?.deletions ?? fromPatch.deletions,
      }
    }),
  ].filter((f) => f.diff.length > 0)

  return { files, branch, refs: { scope } }
}

/**
 * Multi-file diff browser tab — Codex's "Review" view.
 *
 * Layout matches codex/extracts/thread-side-panel-tabs/_Component67:
 *   single-row toolbar = [scope ▾] [+N -N] [head → target ▾]   [view mode] [tree]
 *   below: scrollable diff list (one file per section)
 *   right: changed-file tree (PierreFileTree, all ancestor dirs expanded)
 *
 * When the overall diff crosses Codex's large-diff thresholds we switch to
 * single-file rendering driven by `activePath` and show a banner.
 */
