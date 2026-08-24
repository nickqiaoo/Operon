/**
 * Shared vocabulary for the review surface. Extracted from ReviewTab.tsx when it
 * crossed 2400 lines; every other file in this folder imports from here.
 */

export interface FileChange {
  /** Path relative to repo root, forward-slash normalized. */
  path: string
  /** Single-letter status (M, A, D, R, ?, …). */
  status: string
  /** Unified diff content. */
  diff: string
  additions: number
  deletions: number
  changedBytes: number
  maxChangedLineBytes: number
}

export interface BranchInfo {
  current: string | null
  ahead: number
  behind: number
}

/**
 * Codex's diff scope:
 *   unstaged → working-tree changes      staged → index
 *   branch   → diff vs a base branch     commit → a single commit's diff
 */
export type DiffScope = "unstaged" | "staged" | "commit" | "branch" | "lastTurn"

/**
 * How to fetch old/new file content for the expand-unchanged UI. Working-tree
 * scopes compare index/HEAD vs disk; range scopes compare two refs.
 */
export interface ReviewRefs {
  scope: DiffScope
  oldRef?: string
  newRef?: string | null
}

/** Per-file actions on a diff (codex's file-header revert/stage controls). */
export type FileAction = "stage" | "unstage" | "revert"
/** Bulk actions in the floating bottom pill. */
export type BulkAction = "stage-all" | "unstage-all" | "revert-all"

/**
 * Codex's global "large diff" gate (`Hae` in the Codex app):
 *   fileCount > 128 || totalChangedLines > 9000 || totalChangedBytes > 12 MiB
 * Switches to single-file rendering only when the whole review is huge.
 */
