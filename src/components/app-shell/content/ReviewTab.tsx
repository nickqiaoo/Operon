import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useIntl } from "react-intl"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Virtualizer, WorkerPoolContextProvider } from "@pierre/diffs/react"
import type { FileDiffOptions } from "@pierre/diffs"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { gitKeys, useGitRepoInvalidation } from "@/lib/git-queries"
import { useAppShellStore } from "@/stores/app-shell-store"
import { useThemeStore } from "@/stores/theme-store"
import { useReviewTurnStore } from "@/stores/review-turn-store"
import type { CommentMeta } from "@/components/editor/comments/useLineComments"
import {
  PANEL_ANIMATION_DURATION,
  SIDE_FILE_TREE_DEFAULT_WIDTH,
  clampSideFileTreeWidth,
} from "../constants"
import { ResizeHandle } from "../ResizeHandle"
import { CommitDialog } from "./CommitDialog"
import type { BulkAction, DiffScope, FileAction } from "./review/types"
import {
  DIFF_SCROLLBAR_CSS,
  LARGE_DIFF_CHANGED_BYTE_THRESHOLD,
  LARGE_DIFF_CHANGED_LINE_THRESHOLD,
  LARGE_DIFF_FILE_COUNT_THRESHOLD,
  PIERRE_HIGHLIGHTER_OPTIONS,
  PIERRE_WORKER_POOL_OPTIONS,
} from "./review/constants"
import { sortFileChangesInTreeOrder } from "./review/diff-utils"
import { loadReview } from "./review/load-review"
import { ReviewToolbar } from "./review/ReviewToolbar"
import { ChangedFilesTree } from "./review/ChangedFilesTree"
import { CappedDiff, FileSection } from "./review/FileSection"
import { BulkActionPill, RevertAllConfirmDialog } from "./review/BulkActionPill"
import { EmptyState } from "./review/ReviewEmptyState"

interface ReviewTabProps {
  tabId: string
  rootPath: string
}

export function ReviewTab({ tabId, rootPath }: ReviewTabProps) {
  const intl = useIntl()
  const [scope, setScope] = useState<DiffScope>("unstaged")
  // Set by the chat panel's "Review" action: which chat's latest turn to show.
  const turnTarget = useReviewTurnStore((s) => s.byRoot[rootPath])
  const turnChatId = turnTarget?.chatId ?? null
  const turnMessageUid = turnTarget?.messageUid ?? null
  // Switch to the Last-turn scope each time the Review button is pressed.
  useEffect(() => {
    if (turnTarget) setScope("lastTurn")
  }, [turnTarget?.nonce])
  // Range-scope selections: base branch for `branch`, commit sha for `commit`.
  const [baseBranch, setBaseBranch] = useState<string | null>(null)
  const [commitSha, setCommitSha] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<"unified" | "split">("unified")
  // Last-turn diffs come from the sidecar repo (not the project git), so the
  // expand-unchanged loader (which reads project git refs) can't resolve them.
  const loadFullFilesEnabled = scope !== "lastTurn"
  const [activePath, setActivePath] = useState<string | null>(null)
  const [collapsedFilePaths, setCollapsedFilePaths] = useState<Set<string>>(() => new Set())
  const [fileTreeWidth, setFileTreeWidth] = useState(SIDE_FILE_TREE_DEFAULT_WIDTH)
  const diffScrollRef = useRef<HTMLDivElement | null>(null)
  const fileTreeRef = useRef<HTMLElement | null>(null)
  const pendingScrollPathRef = useRef<string | null>(null)

  const isTreeVisible = useAppShellStore((s) => !s.workspaceTreeHidden[tabId])
  const toggleWorkspaceTree = useAppShellStore((s) => s.toggleWorkspaceTree)

  const theme = useThemeStore((s) => s.theme)
  const themeType = useMemo(() => {
    if (theme === "system") return "system" as const
    return theme === "dark" ? ("dark" as const) : ("light" as const)
  }, [theme])

  const diffOptions = useMemo<FileDiffOptions<CommentMeta>>(
    () => ({
      diffStyle: viewMode,
      diffIndicators: "bars" as const,
      // No intra-line (word/char) highlighting — only the line is marked
      // changed, not the specific tokens within it.
      lineDiffType: "none" as const,
      overflow: "scroll" as const,
      hunkSeparators: "line-info" as const,
      // Pierre's built-in file header would duplicate the path we already
      // render in FileSection's <header>. Codex's review tab also disables
      // it (the path lives in the section header, not inside the diff card).
      disableFileHeader: true,
      disableBackground: false,
      themeType,
      theme: { light: "pierre-light", dark: "pierre-dark" },
      unsafeCSS: DIFF_SCROLLBAR_CSS,
    }),
    [themeType, viewMode],
  )

  // Live updates: subscribe this repo to the git-repo-watcher and invalidate
  // its `['git', root]` queries whenever the working tree / git internals
  // change on disk — external `git commit`s, fetches and outside edits all
  // refresh the diff without polling.
  useGitRepoInvalidation(rootPath)

  // Resolve the default base branch the first time the branch scope is opened.
  useEffect(() => {
    if (scope !== "branch" || baseBranch != null) return
    let cancelled = false
    void api.gitDefaultBaseBranch(rootPath).then((base) => {
      if (!cancelled && base) setBaseBranch(base)
    })
    return () => {
      cancelled = true
    }
  }, [scope, baseBranch, rootPath])

  // Default the commit scope to the latest commit on HEAD.
  useEffect(() => {
    if (scope !== "commit" || commitSha != null) return
    let cancelled = false
    void api.gitCommits(rootPath, 1).then((commits) => {
      if (!cancelled && commits[0]) setCommitSha(commits[0].sha)
    })
    return () => {
      cancelled = true
    }
  }, [scope, commitSha, rootPath])

  // Range scopes need their selection resolved before the query can run.
  const variant =
    scope === "branch" ? baseBranch ?? ""
    : scope === "commit" ? commitSha ?? ""
    : scope === "lastTurn" ? `${turnChatId ?? ""}:${turnMessageUid ?? ""}`
    : ""
  const queryEnabled =
    scope === "unstaged" ||
    scope === "staged" ||
    (scope === "branch" && baseBranch != null) ||
    (scope === "commit" && commitSha != null) ||
    (scope === "lastTurn" && turnChatId != null)

  const reviewQuery = useQuery({
    queryKey: gitKeys.review(rootPath, scope, variant),
    queryFn: () =>
      loadReview(rootPath, scope, {
        baseBranch,
        commitSha,
        turnChatId,
        turnMessageUid,
      }),
    enabled: queryEnabled,
    staleTime: 5_000,
  })

  // `data` is kept across refetches of the same key, so watcher-driven reloads
  // swap the diff in place (no flash); only a scope/repo switch shows loading.
  const loadedFiles = reviewQuery.data?.files ?? null
  const files = useMemo(
    () => (loadedFiles == null ? null : sortFileChangesInTreeOrder(loadedFiles)),
    [loadedFiles],
  )
  const branch = reviewQuery.data?.branch ?? null
  const refs = useMemo(() => reviewQuery.data?.refs ?? { scope }, [reviewQuery.data?.refs, scope])
  const error =
    reviewQuery.error == null
      ? null
      : reviewQuery.error instanceof Error
        ? reviewQuery.error.message
        : intl.formatMessage({
            id: "review.failedToLoad",
            defaultMessage: "Failed to load changes",
          })

  // File tree can only appear when there are changed files to list.
  const hasChangedFiles = files != null && files.length > 0
  // Keep the panel in the DOM whenever there are files so open/close is a pure
  // width transition (no mount/unmount pop at the end of the slide).
  const treeOpen = isTreeVisible && hasChangedFiles
  // Disable width transition while the user is dragging the resize handle.
  const [isResizingTree, setIsResizingTree] = useState(false)

  const queryClient = useQueryClient()
  const [confirmRevertAll, setConfirmRevertAll] = useState(false)
  const [commitDialogOpen, setCommitDialogOpen] = useState(false)

  // Stage/unstage/revert run through the existing porcelain endpoints; the
  // watcher also fires on the resulting index/working-tree change, but we
  // invalidate eagerly so the diff updates the instant the request resolves.
  const refreshGit = useCallback(
    () => queryClient.invalidateQueries({ queryKey: gitKeys.all(rootPath) }),
    [queryClient, rootPath],
  )

  const runFileAction = useCallback(
    async (path: string, action: FileAction) => {
      try {
        if (action === "stage") await api.gitStage(rootPath, path)
        else if (action === "unstage") await api.gitUnstage(rootPath, path)
        else await api.gitRestore(rootPath, path)
        await refreshGit()
        toast.success(
          action === "stage"
            ? intl.formatMessage(
                { id: "review.toast.staged", defaultMessage: "Staged {path}" },
                { path },
              )
            : action === "unstage"
              ? intl.formatMessage(
                  {
                    id: "review.toast.unstaged",
                    defaultMessage: "Unstaged {path}",
                  },
                  { path },
                )
              : intl.formatMessage(
                  {
                    id: "review.toast.reverted",
                    defaultMessage: "Reverted {path}",
                  },
                  { path },
                ),
        )
      } catch {
        toast.error(
          action === "stage"
            ? intl.formatMessage(
                {
                  id: "review.toast.stageFailed",
                  defaultMessage: "Failed to stage {path}",
                },
                { path },
              )
            : action === "unstage"
              ? intl.formatMessage(
                  {
                    id: "review.toast.unstageFailed",
                    defaultMessage: "Failed to unstage {path}",
                  },
                  { path },
                )
              : intl.formatMessage(
                  {
                    id: "review.toast.revertFailed",
                    defaultMessage: "Failed to revert {path}",
                  },
                  { path },
                ),
        )
      }
    },
    [intl, refreshGit, rootPath],
  )

  const runBulkAction = async (action: BulkAction) => {
    try {
      if (action === "stage-all") await api.gitStageAll(rootPath)
      else if (action === "unstage-all") await api.gitUnstageAll(rootPath)
      else await api.gitRestoreAll(rootPath)
      await refreshGit()
      toast.success(
        action === "stage-all"
          ? intl.formatMessage({
              id: "review.toast.stagedAll",
              defaultMessage: "Staged all changes",
            })
          : action === "unstage-all"
            ? intl.formatMessage({
                id: "review.toast.unstagedAll",
                defaultMessage: "Unstaged all changes",
              })
            : intl.formatMessage({
                id: "review.toast.revertedAll",
                defaultMessage: "Reverted all changes",
              }),
      )
    } catch {
      toast.error(
        intl.formatMessage({
          id: "review.toast.actionFailed",
          defaultMessage: "Action failed",
        }),
      )
    }
  }

  const totals = useMemo(() => {
    if (files == null) {
      return {
        additions: 0,
        deletions: 0,
        changedBytes: 0,
        changedLines: 0,
      }
    }
    let additions = 0
    let deletions = 0
    let changedBytes = 0
    for (const f of files) {
      // Codex keeps untracked files visible in the review, but its summary
      // totals come from git numstat and therefore exclude those files.
      if (scope !== "unstaged" || f.status !== "?") {
      additions += f.additions
      deletions += f.deletions
      }
      changedBytes += f.changedBytes
    }
    return {
      additions,
      deletions,
      changedBytes,
      changedLines: additions + deletions,
    }
  }, [files, scope])

  const isCapped =
    files != null &&
    (files.length > LARGE_DIFF_FILE_COUNT_THRESHOLD ||
      totals.changedLines > LARGE_DIFF_CHANGED_LINE_THRESHOLD ||
      totals.changedBytes > LARGE_DIFF_CHANGED_BYTE_THRESHOLD)

  const scrollToReviewPath = (path: string) => {
    const escapedPath =
      typeof CSS !== "undefined" && CSS.escape != null
        ? CSS.escape(path)
        : path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    diffScrollRef.current
      ?.querySelector<HTMLElement>(`[data-review-path="${escapedPath}"]`)
      ?.scrollIntoView({ block: "start", behavior: "auto" })
  }

  const handleSelectPath = (path: string | null) => {
    pendingScrollPathRef.current = path
    if (path != null && path === activePath && !isCapped) {
      window.requestAnimationFrame(() => {
        scrollToReviewPath(path)
        pendingScrollPathRef.current = null
      })
      return
    }
    setActivePath(path)
  }

  const setFileCollapsed = useCallback((path: string, collapsed: boolean) => {
    setCollapsedFilePaths((prev) => {
      const next = new Set(prev)
      if (collapsed) {
        next.add(path)
      } else {
        next.delete(path)
      }
      return next
    })
  }, [])

  const expandAllDiffs = () => setCollapsedFilePaths(new Set())

  const collapseAllDiffs = () => {
    setCollapsedFilePaths(new Set((files ?? []).map((file) => file.path)))
  }

  const areAllDiffsCollapsed =
    files != null && files.length > 0 && files.every((file) => collapsedFilePaths.has(file.path))

  const toggleAllDiffs = () => {
    if (areAllDiffsCollapsed) {
      expandAllDiffs()
    } else {
      collapseAllDiffs()
    }
  }

  // Default the active path to the first file once we have data; keep the
  // user's selection valid across reloads.
  useEffect(() => {
    if (files == null || files.length === 0) {
      setActivePath(null)
      return
    }
    if (activePath == null || !files.some((f) => f.path === activePath)) {
      setActivePath(files[0].path)
    }
  }, [files, activePath])

  useEffect(() => {
    if (files == null) {
      setCollapsedFilePaths((prev) => (prev.size === 0 ? prev : new Set()))
      return
    }

    const validPaths = new Set(files.map((file) => file.path))
    setCollapsedFilePaths((prev) => {
      const next = new Set<string>()
      for (const path of prev) {
        if (validPaths.has(path)) next.add(path)
      }
      return next.size === prev.size ? prev : next
    })
  }, [files])

  useEffect(() => {
    if (files == null) return
    const pendingPath = pendingScrollPathRef.current
    if (pendingPath == null || pendingPath !== activePath) return
    if (!files.some((file) => file.path === pendingPath)) return

    const frame = window.requestAnimationFrame(() => {
      if (isCapped) {
        const scrollContainer = diffScrollRef.current?.querySelector<HTMLElement>(".code-scrollbar")
        if (scrollContainer != null) scrollContainer.scrollTop = 0
      } else {
        scrollToReviewPath(pendingPath)
      }
      pendingScrollPathRef.current = null
    })

    return () => window.cancelAnimationFrame(frame)
  }, [activePath, files, isCapped])

  // Codex layout: one full-width review header (buttons always live here), then
  // a content row of [diff | sliding file-tree]. The tree never hosts chrome —
  // dual-hosting is what made the button strip flash on open/close.
  return (
    <WorkerPoolContextProvider
      poolOptions={PIERRE_WORKER_POOL_OPTIONS}
      highlighterOptions={PIERRE_HIGHLIGHTER_OPTIONS}
    >
    <div className="flex h-full min-h-0 flex-col">
      <ReviewToolbar
        scope={scope}
        onScopeChange={setScope}
        showLastTurn={turnChatId != null}
        branch={branch}
        totals={totals}
        files={files ?? []}
        activePath={activePath}
        onSelectPath={handleSelectPath}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        isTreeVisible={treeOpen}
        onToggleTree={() => toggleWorkspaceTree(tabId)}
        areAllDiffsCollapsed={areAllDiffsCollapsed}
        onToggleAllDiffs={toggleAllDiffs}
        onCommit={() => setCommitDialogOpen(true)}
        rootPath={rootPath}
        baseBranch={baseBranch}
        onBaseBranchChange={setBaseBranch}
        commitSha={commitSha}
        onCommitShaChange={setCommitSha}
      />
      {isCapped && (
        <div className="shrink-0 px-3 pt-3 text-xs text-muted-foreground">
          Large diff detected — showing one file at a time.
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div ref={diffScrollRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {error != null ? (
            <div className="flex h-full items-center justify-center px-4 text-xs text-destructive">
              {error}
            </div>
          ) : files == null ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Loading changes…
            </div>
          ) : files.length === 0 ? (
            <EmptyState scope={scope} />
          ) : isCapped ? (
            <div className="code-scrollbar min-h-0 flex-1 overflow-auto">
              <CappedDiff
                files={files}
                activePath={activePath}
                diffOptions={diffOptions}
                rootPath={rootPath}
                scope={scope}
                refs={refs}
                collapsedFilePaths={collapsedFilePaths}
                onFileCollapsedChange={setFileCollapsed}
                onFileAction={runFileAction}
                loadFullFilesEnabled={loadFullFilesEnabled}
              />
            </div>
          ) : (
            // Pierre's <Virtualizer> is the scroll container: each <FileDiff>
            // inside auto-detects it (via VirtualizerContext) and only renders
            // the on-screen window of a file, drawing an equal-height
            // placeholder for the rest. Keeps scrolling smooth with many files.
            <Virtualizer
              className="code-scrollbar min-h-0 flex-1 overflow-auto"
              contentClassName="space-y-1 pb-2 pt-0"
            >
              {files.map((file) => (
                <FileSection
                  key={`${file.status}:${file.path}`}
                  file={file}
                  diffOptions={diffOptions}
                  rootPath={rootPath}
                  scope={scope}
                  refs={refs}
                  isActive={activePath === file.path}
                  collapsed={collapsedFilePaths.has(file.path)}
                  onCollapsedChange={setFileCollapsed}
                  onFileAction={runFileAction}
                  loadFullFilesEnabled={loadFullFilesEnabled}
                />
              ))}
            </Virtualizer>
          )}
          {error == null &&
            files != null &&
            files.length > 0 &&
            (scope === "unstaged" || scope === "staged") && (
              <BulkActionPill
                scope={scope}
                onStageAll={() => runBulkAction("stage-all")}
                onUnstageAll={() => runBulkAction("unstage-all")}
                onRevertAll={() => setConfirmRevertAll(true)}
              />
            )}
        </div>

        {/*
          Codex file-tree panel: width 0 ↔ target only. Contains search + paths
          — never the action chrome (that stays on the shared review header).
        */}
        {hasChangedFiles && files != null && (
          <aside
            ref={fileTreeRef}
            className={cn(
              "relative h-full min-h-0 min-w-0 shrink-0 overflow-hidden border-l border-border/50",
              !isResizingTree &&
                "transition-[width] ease-[cubic-bezier(0.32,0.72,0,1)] will-change-[width]",
              !treeOpen && "pointer-events-none",
            )}
            style={{
              width: treeOpen ? fileTreeWidth : 0,
              transitionDuration: isResizingTree ? "0ms" : `${PANEL_ANIMATION_DURATION * 1000}ms`,
            }}
            aria-hidden={!treeOpen}
        >
            <div
              className="absolute top-0 bottom-0 right-0 flex min-w-0 flex-col bg-background"
              style={{ width: fileTreeWidth, minWidth: fileTreeWidth }}
            >
              <ChangedFilesTree
                files={files}
                activePath={activePath}
                onSelectPath={handleSelectPath}
                className="h-full"
              />
            </div>
            {treeOpen && (
          <ResizeHandle
            edge="left"
            defaultSize={SIDE_FILE_TREE_DEFAULT_WIDTH}
            getSizeFromPointer={({ x }) => {
              const right =
                    fileTreeRef.current?.getBoundingClientRect().right ?? window.innerWidth
              return right - x
            }}
                setSize={(next) => setFileTreeWidth(clampSideFileTreeWidth(next))}
                onResizingChange={setIsResizingTree}
          />
      )}
          </aside>
        )}
      </div>

      <RevertAllConfirmDialog
        open={confirmRevertAll}
        onOpenChange={setConfirmRevertAll}
        onConfirm={() => {
          setConfirmRevertAll(false)
          void runBulkAction("revert-all")
        }}
      />
      <CommitDialog
        open={commitDialogOpen}
        onOpenChange={setCommitDialogOpen}
        rootPath={rootPath}
        branch={branch?.current ?? null}
        fileCount={files?.length ?? 0}
        additions={totals.additions}
        deletions={totals.deletions}
      />
    </div>
    </WorkerPoolContextProvider>
  )
}

// ---------------------------------------------------------------------------

