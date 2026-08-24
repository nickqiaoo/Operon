import { defineMessages, type MessageDescriptor } from "react-intl"
import type { WorkerInitializationRenderOptions, WorkerPoolOptions } from "@pierre/diffs/react"
// Pierre ships its own worker pool that runs shiki syntax highlighting off the
// main thread. Vite's `?worker` bundles this entry as a standalone ES-module
// worker; `WorkerPoolContextProvider` in ReviewTab feeds it to every
// FileDiff/PatchDiff via context. If the worker can't start, Pierre falls back to
// main-thread highlighting (isWorkingPool() → false), i.e. the previous behavior.
import PierreDiffWorker from "@pierre/diffs/worker/worker.js?worker"
import type { GitStatus } from "@pierre/trees"
import type { DiffScope } from "./types"

export const LARGE_DIFF_FILE_COUNT_THRESHOLD = 128
export const LARGE_DIFF_CHANGED_LINE_THRESHOLD = 9_000
export const LARGE_DIFF_CHANGED_BYTE_THRESHOLD = 12 * 1024 * 1024 // 12_582_912
export const FULL_FILE_CHANGED_LINE_THRESHOLD = 15_000
export const FULL_FILE_CHANGED_BYTE_THRESHOLD = 3 * 1024 * 1024
export const FULL_FILE_MAX_CHANGED_LINE_BYTE_THRESHOLD = 1024 * 1024

// Off-main-thread highlighting via Pierre's shiki worker pool. Both objects are
// read once, when the provider first mounts (getOrCreateWorkerPoolSingleton), so
// they're module-level constants rather than per-render literals.
export const PIERRE_WORKER_POOL_OPTIONS: WorkerPoolOptions = {
  workerFactory: () => new PierreDiffWorker(),
}
export const PIERRE_HIGHLIGHTER_OPTIONS: WorkerInitializationRenderOptions = {
  // Match the review's render options (diffOptions.lineDiffType below): no
  // intra-line word/char diffing, only whole changed lines are marked.
  lineDiffType: "none",
}

export const DIFF_SCROLLBAR_CSS = `
/* No standard scrollbar-width/color: setting them makes Chromium 121+ ignore
   the ::-webkit-scrollbar rules below (so the vertical bar wouldn't hide and
   the horizontal bar would render as the native overlay). */
[data-code] {
  background-color: var(--diffs-bg);
}

[data-code]::-webkit-scrollbar {
  width: 0;
  height: 8px;
}

[data-code]::-webkit-scrollbar-track {
  background: transparent;
}

[data-code]::-webkit-scrollbar-corner {
  background: var(--diffs-bg);
}

[data-code]::-webkit-scrollbar-thumb {
  background-color: color-mix(in lab, var(--diffs-bg) 84%, var(--diffs-fg));
  border: 2px solid transparent;
  background-clip: content-box;
  border-radius: 999px;
}

[data-code]::-webkit-scrollbar-thumb:hover {
  background-color: color-mix(in lab, var(--diffs-bg) 72%, var(--diffs-fg));
}

[data-unified] [data-separator=line-info] {
  background-color: transparent !important;
  height: 28px !important;
}

/* Pierre's collapsed context row paints the wrapper gutters in --diffs-bg.
   Codex flattens that wrapper into the separator surface so the right gutter
   and expand-button borders do not show up as white seams. */
[data-unified] [data-separator=line-info] [data-separator-wrapper] {
  background-color: transparent !important;
}

[data-unified] [data-separator=line-info] [data-expand-button] {
  background-color: var(--diffs-bg-separator) !important;
  border-bottom-left-radius: 6px;
  border-top-left-radius: 6px;
}

[data-unified] [data-separator=line-info] [data-separator-content] {
  background-color: var(--diffs-bg-separator) !important;
  border-bottom-right-radius: 6px;
  border-top-right-radius: 6px;
  color: var(--diffs-fg-number) !important;
}

[data-unified] [data-separator=line-info] [data-unmodified-lines] {
  color: var(--diffs-fg-number) !important;
  opacity: 1;
}

[data-expand-button],
[data-expand-up],
[data-expand-down] {
  border-color: var(--diffs-bg-separator) !important;
}
`


export const SCOPE_MESSAGES: Record<DiffScope, MessageDescriptor> = defineMessages({
  unstaged: { id: "review.scope.unstaged", defaultMessage: "Unstaged" },
  staged: { id: "review.scope.staged", defaultMessage: "Staged" },
  commit: { id: "review.scope.commit", defaultMessage: "Commit" },
  branch: { id: "review.scope.branch", defaultMessage: "Branch" },
  lastTurn: { id: "review.scope.lastTurn", defaultMessage: "Last turn" },
})

export const EMPTY_TITLE: Record<DiffScope, MessageDescriptor> = defineMessages({
  lastTurn: {
    id: "review.empty.lastTurn.title",
    defaultMessage: "No changes this turn",
  },
  staged: {
    id: "review.empty.staged.title",
    defaultMessage: "No staged changes",
  },
  branch: {
    id: "review.empty.branch.title",
    defaultMessage: "No differences from base",
  },
  commit: {
    id: "review.empty.commit.title",
    defaultMessage: "This commit has no changes",
  },
  unstaged: {
    id: "review.empty.unstaged.title",
    defaultMessage: "No pending changes",
  },
})

export const EMPTY_HINT: Record<DiffScope, MessageDescriptor> = defineMessages({
  lastTurn: {
    id: "review.empty.lastTurn.hint",
    defaultMessage: "The last turn didn't modify any files.",
  },
  staged: {
    id: "review.empty.staged.hint",
    defaultMessage: "Stage edits to see them here.",
  },
  branch: {
    id: "review.empty.branch.hint",
    defaultMessage: "This branch matches its base.",
  },
  commit: {
    id: "review.empty.commit.hint",
    defaultMessage: "The selected commit is empty.",
  },
  unstaged: {
    id: "review.empty.unstaged.hint",
    defaultMessage: "The working tree matches HEAD.",
  },
})

/** Build per-file changes for a ref range (branch/commit scopes). */

export const PIERRE_GIT_STATUS: Record<string, GitStatus> = {
  A: "added",
  D: "deleted",
  M: "modified",
  R: "renamed",
  "?": "untracked",
}

