import { memo, useEffect, useMemo, useRef, useState } from "react"
import { useIntl } from "react-intl"
import { useQuery } from "@tanstack/react-query"
import { FileDiff, PatchDiff } from "@pierre/diffs/react"
import {
  parseDiffFromFile,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type FileDiffOptions,
} from "@pierre/diffs"
import { ChevronDown, Minus, Plus, Undo2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { gitKeys } from "@/lib/git-queries"
import { useEditorStore } from "@/stores/editor-store"
import { useLineComments, type CommentMeta } from "@/components/editor/comments/useLineComments"
import type { DiffScope, FileAction, FileChange, ReviewRefs } from "./types"
import {
  FULL_FILE_CHANGED_BYTE_THRESHOLD,
  FULL_FILE_CHANGED_LINE_THRESHOLD,
  FULL_FILE_MAX_CHANGED_LINE_BYTE_THRESHOLD,
} from "./constants"
import { joinPath, normalizePatch } from "./diff-utils"
import { DiffStats } from "./DiffStats"

export interface CappedDiffProps {
  files: FileChange[]
  activePath: string | null
  diffOptions: FileDiffOptions<CommentMeta>
  rootPath: string
  scope: DiffScope
  refs: ReviewRefs
  collapsedFilePaths: Set<string>
  onFileCollapsedChange: (path: string, collapsed: boolean) => void
  onFileAction: (path: string, action: FileAction) => void
  loadFullFilesEnabled: boolean
}

export function CappedDiff({
  files,
  activePath,
  diffOptions,
  rootPath,
  scope,
  refs,
  collapsedFilePaths,
  onFileCollapsedChange,
  onFileAction,
  loadFullFilesEnabled,
}: CappedDiffProps) {
  const file = files.find((f) => f.path === activePath) ?? files[0]
  if (file == null) return null
  return (
    <div className="pb-2 pt-0">
      <FileSection
        file={file}
        diffOptions={diffOptions}
        rootPath={rootPath}
        scope={scope}
        refs={refs}
        isActive
        collapsed={collapsedFilePaths.has(file.path)}
        onCollapsedChange={onFileCollapsedChange}
        onFileAction={onFileAction}
        loadFullFilesEnabled={loadFullFilesEnabled}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * Floating bottom-center pill — codex's "Stage all / Revert all" review action
 * bar. On the staged scope it collapses to a single "Unstage all".
 */

export interface FileSectionProps {
  file: FileChange
  diffOptions: FileDiffOptions<CommentMeta>
  rootPath: string
  scope: DiffScope
  refs: ReviewRefs
  isActive: boolean
  collapsed: boolean
  onCollapsedChange: (path: string, collapsed: boolean) => void
  onFileAction: (path: string, action: FileAction) => void
  loadFullFilesEnabled: boolean
}

export const FileSection = memo(function FileSection({
  file,
  diffOptions,
  rootPath,
  scope,
  refs,
  isActive,
  collapsed,
  onCollapsedChange,
  onFileAction,
  loadFullFilesEnabled,
}: FileSectionProps) {
  const patch = useMemo(() => normalizePatch(file.path, file.diff), [file])
  const sectionRef = useRef<HTMLElement | null>(null)
  const [isNearViewport, setIsNearViewport] = useState(false)
  useEffect(() => {
    const section = sectionRef.current
    if (section == null || isNearViewport) return
    if (typeof IntersectionObserver === "undefined") {
      setIsNearViewport(true)
      return
    }
    const scrollRoot = section.closest<HTMLElement>(".code-scrollbar")
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setIsNearViewport(true)
        observer.disconnect()
      },
      { root: scrollRoot, rootMargin: "800px 0px" },
    )
    observer.observe(section)
    return () => observer.disconnect()
  }, [isNearViewport])
  const workspaceId = useEditorStore((s) => s.currentWorkspaceId)
  const { entries, renderCard, selectedLines, onGutterUtilityClick } = useLineComments({
    workspaceId,
    path: file.path,
    mode: "diff",
  })
  const lineAnnotations = useMemo<DiffLineAnnotation<CommentMeta>[]>(
    () =>
      entries.map((entry) => ({
        side: entry.side === "left" ? "deletions" : "additions",
        lineNumber: entry.line,
        metadata: entry.meta,
      })),
    [entries],
  )
  const commentDiffOptions = useMemo<FileDiffOptions<CommentMeta>>(
    () => ({
      ...diffOptions,
      // Keep Pierre's VirtualizedFileDiff instance mounted and let it update
      // its own layout/cache when the custom file header is collapsed.
      collapsed,
      enableGutterUtility: true,
      lineHoverHighlight: "line" as const,
      onGutterUtilityClick,
    }),
    [collapsed, diffOptions, onGutterUtilityClick],
  )

  // Stage/unstage/revert only apply to working-tree scopes; range scopes
  // (branch/commit) are a read-only review of history.
  const showFileActions = scope === "unstaged" || scope === "staged"

  // Fetch the old + new file contents and feed Pierre's FileDiff (which knows
  // how to render the expand-unchanged chevrons). Without full contents, fall
  // back to PatchDiff — that path only shows patch context, no expand UI.
  // Expansion requires a non-partial diff, which `parseDiffFromFile` produces.
  const fullFileTooLarge =
    file.additions + file.deletions > FULL_FILE_CHANGED_LINE_THRESHOLD ||
    file.changedBytes > FULL_FILE_CHANGED_BYTE_THRESHOLD ||
    file.maxChangedLineBytes > FULL_FILE_MAX_CHANGED_LINE_BYTE_THRESHOLD
  const fullFileDiff = useFullFileDiff(
    file,
    rootPath,
    refs,
    loadFullFilesEnabled && !collapsed && !fullFileTooLarge && (isActive || isNearViewport),
  )

  return (
    <section
      ref={sectionRef}
      className="group/file-diff flex flex-col overflow-hidden rounded-lg bg-[#f8fafc] dark:bg-[#0c0c0e]"
      data-review-path={file.path}
    >
      <header className="flex h-6 items-center gap-2 px-2 text-xs">
        <button
          type="button"
          onClick={() => onCollapsedChange(file.path, !collapsed)}
          aria-label={collapsed ? "Expand diff" : "Collapse diff"}
          className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className={cn("h-3 w-3 transition-transform", collapsed && "-rotate-90")} />
        </button>
        <div className="min-w-0 flex-1 truncate font-medium">{file.path}</div>
        {showFileActions && (
          <FileActionButtons scope={scope} onAction={(action) => onFileAction(file.path, action)} />
        )}
        <DiffStats additions={file.additions} deletions={file.deletions} />
      </header>
      <div className="text-sm">
        {fullFileDiff != null ? (
          <FileDiff
            fileDiff={fullFileDiff}
            className="pierre-diff-file-view"
            options={commentDiffOptions}
            lineAnnotations={lineAnnotations}
            selectedLines={selectedLines}
            renderAnnotation={(annotation) => renderCard(annotation.metadata)}
          />
        ) : (
          <PatchDiff<CommentMeta>
            patch={patch}
            className="pierre-diff-file-view"
            options={commentDiffOptions}
            lineAnnotations={lineAnnotations}
            selectedLines={selectedLines}
            renderAnnotation={(annotation) => renderCard(annotation.metadata)}
          />
        )}
      </div>
    </section>
  )
})

/**
 * Hover-revealed per-file controls in the diff header (codex's file-level
 * revert/stage). Unstaged scope shows revert + stage; staged scope shows
 * unstage. Kept out of the tab order until the row is hovered/focused.
 */
export function FileActionButtons({
  scope,
  onAction,
}: {
  scope: DiffScope
  onAction: (action: FileAction) => void
}) {
  const intl = useIntl()
  const isStaged = scope === "staged"
  const unstageLabel = intl.formatMessage({
    id: "review.unstageFile",
    defaultMessage: "Unstage file",
  })
  const revertLabel = intl.formatMessage({
    id: "review.revertFile",
    defaultMessage: "Revert file",
  })
  const stageLabel = intl.formatMessage({
    id: "review.stageFile",
    defaultMessage: "Stage file",
  })
  const fire = (action: FileAction) => (event: React.MouseEvent) => {
    event.stopPropagation()
    onAction(action)
  }
  const buttonClass =
    "flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"

  return (
    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/file-diff:opacity-100">
      {isStaged ? (
        <button
          type="button"
          onClick={fire("unstage")}
          aria-label={unstageLabel}
          title={unstageLabel}
          className={buttonClass}
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={fire("revert")}
            aria-label={revertLabel}
            title={revertLabel}
            className={buttonClass}
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={fire("stage")}
            aria-label={stageLabel}
            title={stageLabel}
            className={buttonClass}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  )
}

/**
 * When `loadFullFilesEnabled` is on, fetch the old + new file blobs and build a
 * full-file diff via Pierre's `parseDiffFromFile`. Because the metadata is
 * generated from complete contents (`isPartial: false`), Pierre's `FileDiff`
 * renders the click-to-expand chevrons over unchanged regions. Returns `null`
 * while loading, when disabled, or on error — callers fall back to `PatchDiff`.
 *
 * (Pierre 1.2.x removed the old `parsePatchFiles` + `oldLines`/`newLines`
 * mutation path; `parseDiffFromFile` is the supported replacement.)
 *
 * Refs we read (by scope):
 *   staged   → old = HEAD,       new = INDEX (`git show :path`)
 *   unstaged → old = INDEX,      new = working tree (readFile from disk)
 *   branch   → old = merge-base, new = working tree
 *   commit   → old = parent sha, new = commit sha
 *
 * `git show` calls return "" when the path doesn't exist at that ref
 * (added/untracked files have no prior; deleted files have no current).
 */
export async function loadFullFileMeta(
  file: FileChange,
  rootPath: string,
  refs: ReviewRefs,
): Promise<FileDiffMetadata> {
  const isUntracked = file.status === "?"
  const isDeleted = file.status === "D"
  const isAdded = file.status === "A" || isUntracked

  let oldRef: string
  let newRef: string | null // null = read from disk
  if (refs.scope === "staged") {
    oldRef = "HEAD"
    newRef = ""
  } else if (refs.scope === "unstaged") {
    oldRef = ""
    newRef = null
  } else {
    // branch / commit — resolved refs come from loadReview.
    oldRef = refs.oldRef ?? ""
    newRef = refs.newRef ?? null
  }

  const [oldText, newText] = await Promise.all([
    isAdded ? Promise.resolve("") : api.gitShow(rootPath, oldRef, file.path).catch(() => ""),
    newRef == null
      ? isDeleted
        ? Promise.resolve("")
        : api.readFile(joinPath(rootPath, file.path)).catch(() => "")
      : api.gitShow(rootPath, newRef, file.path).catch(() => ""),
  ])

  // Generate the diff from full contents so `isPartial` is false and the
  // expand-unchanged UI is available.
  return parseDiffFromFile(
    { name: file.path, contents: oldText },
    { name: file.path, contents: newText },
  )
}

export function useFullFileDiff(
  file: FileChange,
  rootPath: string,
  refs: ReviewRefs,
  enabled: boolean,
): FileDiffMetadata | null {
  // The range refs are part of the key so switching base/commit refetches.
  const variant = `${refs.oldRef ?? ""}:${refs.newRef ?? ""}`
  const query = useQuery({
    // `file.status` is part of the key: added/deleted/staged pick different
    // old/new refs, so a status change must produce a fresh blob diff.
    queryKey: [...gitKeys.fullFile(rootPath, refs.scope, file.path, variant), file.status],
    queryFn: () => loadFullFileMeta(file, rootPath, refs),
    enabled,
    staleTime: 5_000,
  })

  // Preserve already loaded metadata while the query is temporarily disabled
  // for a collapsed file. This keeps the mounted renderer type stable across
  // collapse/expand instead of falling back from FileDiff to PatchDiff.
  return query.data ?? null
}

