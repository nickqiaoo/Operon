import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { ArrowLeft, ChevronDown, ChevronRight, FileDiff, ListCollapse, ListRestart, RefreshCw } from "lucide-react"
import { PatchDiff } from "@pierre/diffs/react"
import { cn } from "@/lib/utils"
import { useThemeStore } from "@/stores/theme-store"

/**
 * Rendering every file's full PatchDiff at once freezes phones on big turns, and
 * a phone has no room for the desktop ReviewTab's file tree. So for large stacked
 * reviews we start files collapsed — the section headers (path + ± counts) become
 * the file list, and each diff renders only when its row is tapped. Mirrors the
 * desktop large-diff cap, minus the tree.
 */
const STACKED_COLLAPSE_ALL_FILE_COUNT = 8
const STACKED_COLLAPSE_FILE_LINE_THRESHOLD = 200

export interface MobileDiffFileBase {
  path: string
  status: string
}

interface MobileDiffBrowserProps<TFile extends MobileDiffFileBase> {
  title: ReactNode
  files: TFile[]
  loadDiff: (file: TFile) => Promise<string>
  viewMode?: "list" | "stacked"
  loading?: boolean
  refreshing?: boolean
  error?: string | null
  emptyTitle: ReactNode
  emptyDescription?: ReactNode
  loadingLabel?: ReactNode
  diffErrorMessage?: string
  onRefresh?: () => void
  autoSelectFirst?: boolean
  className?: string
}

/**
 * Phone-sized changed-file browser shared by the Changes tab and chat turn
 * review sheet. It keeps the mobile interaction simple: list of files, then a
 * single-file unified diff rendered by Pierre's PatchDiff.
 */
export function MobileDiffBrowser<TFile extends MobileDiffFileBase>({
  title,
  files,
  loadDiff,
  viewMode = "list",
  loading = false,
  refreshing = false,
  error = null,
  emptyTitle,
  emptyDescription,
  loadingLabel = "Loading changes...",
  diffErrorMessage = "Couldn't load diff.",
  onRefresh,
  autoSelectFirst = false,
  className,
}: MobileDiffBrowserProps<TFile>) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [diff, setDiff] = useState("")
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [stackedDiffs, setStackedDiffs] = useState<Record<string, { diff: string; loading: boolean; error: string | null }>>({})
  const [collapsedFilePaths, setCollapsedFilePaths] = useState<Set<string>>(() => new Set())

  const theme = useThemeStore((s) => s.theme)
  const themeType = theme === "system" ? "system" : theme === "dark" ? "dark" : "light"

  const diffOptions = useMemo<Record<string, unknown>>(
    () => ({
      diffStyle: "unified" as const,
      diffIndicators: "bars" as const,
      lineDiffType: "none" as const,
      overflow: "scroll" as const,
      hunkSeparators: "line-info" as const,
      disableFileHeader: true,
      disableBackground: false,
      themeType,
      theme: { light: "pierre-light", dark: "pierre-dark" },
    }),
    [themeType]
  )

  // Change counts per loaded file, reused for the header ± badge and for the
  // large-diff decision (so we don't re-scan every diff string on each render).
  const metricsByPath = useMemo(() => {
    const map: Record<string, { additions: number; deletions: number }> = {}
    for (const path of Object.keys(stackedDiffs)) {
      const entry = stackedDiffs[path]
      if (entry?.diff) map[path] = countDiffMetrics(entry.diff)
    }
    return map
  }, [stackedDiffs])

  // A stacked review is "large" when it has many files, or any single file has a
  // heavy diff — either way we collapse by default and surface a hint.
  const stackedIsLarge =
    viewMode === "stacked" &&
    (files.length >= STACKED_COLLAPSE_ALL_FILE_COUNT ||
      Object.values(metricsByPath).some(
        (m) => m.additions + m.deletions >= STACKED_COLLAPSE_FILE_LINE_THRESHOLD
      ))

  const selectedFile = selectedPath
    ? files.find((file) => file.path === selectedPath) ?? null
    : null
  const allStackedFilesCollapsed =
    viewMode === "stacked" &&
    files.length > 0 &&
    files.every((file) => collapsedFilePaths.has(file.path))

  const openFile = useCallback(async (file: TFile) => {
    setSelectedPath(file.path)
    setDiff("")
    setDiffError(null)
    setDiffLoading(true)
    try {
      setDiff(await loadDiff(file))
    } catch {
      setDiff("")
      setDiffError(diffErrorMessage)
    } finally {
      setDiffLoading(false)
    }
  }, [diffErrorMessage, loadDiff])

  useEffect(() => {
    if (!selectedPath) return
    if (files.some((file) => file.path === selectedPath)) return
    setSelectedPath(null)
    setDiff("")
    setDiffError(null)
  }, [files, selectedPath])

  useEffect(() => {
    if (viewMode === "stacked" || !autoSelectFirst || selectedPath || loading || files.length === 0) return
    void openFile(files[0])
  }, [autoSelectFirst, files, loading, openFile, selectedPath, viewMode])

  useEffect(() => {
    if (viewMode !== "stacked") {
      setStackedDiffs({})
      return
    }
    if (loading) return

    const paths = new Set(files.map((file) => file.path))
    setStackedDiffs((prev) => {
      const next: Record<string, { diff: string; loading: boolean; error: string | null }> = {}
      for (const file of files) {
        next[file.path] = prev[file.path] ?? { diff: "", loading: true, error: null }
      }
      return next
    })

    let cancelled = false
    for (const file of files) {
      if (!paths.has(file.path)) continue
      void loadDiff(file)
        .then((loadedDiff) => {
          if (cancelled) return
          setStackedDiffs((prev) => ({
            ...prev,
            [file.path]: { diff: loadedDiff, loading: false, error: null },
          }))
          // Collapse heavy files in the same batch as their diff lands so the big
          // PatchDiff never renders expanded (that render is what freezes).
          const metrics = countDiffMetrics(loadedDiff)
          if (metrics.additions + metrics.deletions >= STACKED_COLLAPSE_FILE_LINE_THRESHOLD) {
            setCollapsedFilePaths((prev) => {
              if (prev.has(file.path)) return prev
              const next = new Set(prev)
              next.add(file.path)
              return next
            })
          }
        })
        .catch(() => {
          if (cancelled) return
          setStackedDiffs((prev) => ({
            ...prev,
            [file.path]: { diff: "", loading: false, error: diffErrorMessage },
          }))
        })
    }

    return () => {
      cancelled = true
    }
  }, [diffErrorMessage, files, loadDiff, loading, viewMode])

  useEffect(() => {
    if (viewMode !== "stacked") {
      setCollapsedFilePaths((prev) => (prev.size === 0 ? prev : new Set()))
      return
    }

    const validPaths = new Set(files.map((file) => file.path))
    // Many-file turns: collapse everything up front so headers act as the file
    // list and no diff renders until tapped. (Single heavy files are collapsed
    // later, as their diff loads.)
    const collapseAll = files.length >= STACKED_COLLAPSE_ALL_FILE_COUNT
    setCollapsedFilePaths((prev) => {
      if (collapseAll) return validPaths
      const next = new Set<string>()
      for (const path of prev) {
        if (validPaths.has(path)) next.add(path)
      }
      return next.size === prev.size ? prev : next
    })
  }, [files, viewMode])

  const toggleStackedFile = useCallback((path: string) => {
    setCollapsedFilePaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  const toggleAllStackedFiles = useCallback(() => {
    setCollapsedFilePaths((prev) => {
      const allCollapsed =
        files.length > 0 &&
        files.every((file) => prev.has(file.path))
      return allCollapsed ? new Set() : new Set(files.map((file) => file.path))
    })
  }, [files])

  if (viewMode !== "stacked" && selectedFile) {
    return (
      <div className={cn("flex h-full min-h-0 flex-col", className)}>
        <div className="flex h-11 shrink-0 items-center border-b border-border/50 px-2">
          <button
            type="button"
            onClick={() => {
              setSelectedPath(null)
              setDiff("")
              setDiffError(null)
            }}
            className="flex min-w-0 items-center gap-1 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          >
            <ArrowLeft className="size-4 shrink-0" />
            <span className="truncate">{title}</span>
          </button>
          <span className="ml-1 min-w-0 truncate font-mono text-xs text-foreground/85">{selectedFile.path}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {diffLoading ? (
            <p className="p-4 text-xs text-muted-foreground/70">Loading diff...</p>
          ) : diffError ? (
            <p className="p-4 text-xs text-destructive">{diffError}</p>
          ) : !diff.trim() ? (
            <p className="p-4 text-xs text-muted-foreground/70">No diff to show.</p>
          ) : (
            <PatchDiff
              patch={normalizePatch(selectedFile.path, diff)}
              className="pierre-diff-file-view"
              options={diffOptions}
            />
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/50 px-4">
        <span className="min-w-0 truncate text-sm font-semibold text-foreground/90">{title}</span>
        <div className="flex shrink-0 items-center gap-1">
          {viewMode === "stacked" && files.length > 0 ? (
            <button
              type="button"
              onClick={toggleAllStackedFiles}
              className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              aria-label={allStackedFilesCollapsed ? "Expand all diffs" : "Collapse all diffs"}
              title={allStackedFilesCollapsed ? "Expand all" : "Collapse all"}
            >
              {allStackedFilesCollapsed ? (
                <ListRestart className="size-3.5" />
              ) : (
                <ListCollapse className="size-3.5" />
              )}
            </button>
          ) : null}
          {onRefresh ? (
            <button
              type="button"
              onClick={onRefresh}
              className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              aria-label="Refresh"
              title="Refresh"
            >
              <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="flex flex-1 items-center justify-center px-8 text-center text-xs text-destructive">
          {error}
        </div>
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center px-8 text-center text-xs text-muted-foreground/70">
          {loadingLabel}
        </div>
      ) : files.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
          <FileDiff className="size-6 text-muted-foreground/60" />
          <p className="text-sm font-medium text-foreground/85">{emptyTitle}</p>
          {emptyDescription ? (
            <p className="text-xs text-muted-foreground/70">{emptyDescription}</p>
          ) : null}
        </div>
      ) : viewMode === "stacked" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {stackedIsLarge ? (
            <p className="px-1 pb-2 text-[11px] leading-snug text-muted-foreground/70">
              Large diff — files are collapsed. Tap a file to view its changes.
            </p>
          ) : null}
          <div className="space-y-3">
            {files.map((file) => {
              const loaded = stackedDiffs[file.path]
              const metrics = metricsByPath[file.path] ?? null
              const collapsed = collapsedFilePaths.has(file.path)
              return (
                <section
                  key={file.path}
                  className="overflow-hidden rounded-xl border border-border/50 bg-background/70"
                >
                  <button
                    type="button"
                    onClick={() => toggleStackedFile(file.path)}
                    className="sticky top-0 z-10 flex w-full items-center gap-2 border-b border-border/40 bg-background/95 px-3 py-2 text-left backdrop-blur hover:bg-muted/35"
                    aria-expanded={!collapsed}
                    title={collapsed ? "Expand diff" : "Collapse diff"}
                  >
                    {collapsed ? (
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/70" />
                    ) : (
                      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground/70" />
                    )}
                    <span className="w-4 shrink-0 text-center font-mono text-xs text-muted-foreground/70">
                      {file.status?.trim()?.[0] ?? "-"}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/85">{file.path}</span>
                    {metrics ? (
                      <span className="shrink-0 text-xs tabular-nums">
                        <span className="text-emerald-600 dark:text-emerald-400">+{metrics.additions}</span>{" "}
                        <span className="text-red-500 dark:text-red-400">-{metrics.deletions}</span>
                      </span>
                    ) : null}
                  </button>
                  {collapsed ? null : (loaded?.loading ?? true) ? (
                    <p className="p-4 text-xs text-muted-foreground/70">Loading diff...</p>
                  ) : loaded.error ? (
                    <p className="p-4 text-xs text-destructive">{loaded.error}</p>
                  ) : !loaded.diff.trim() ? (
                    <p className="p-4 text-xs text-muted-foreground/70">No diff to show.</p>
                  ) : (
                    <PatchDiff
                      patch={normalizePatch(file.path, loaded.diff)}
                      className="pierre-diff-file-view"
                      options={diffOptions}
                    />
                  )}
                </section>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              onClick={() => void openFile(file)}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-muted/40"
            >
              <span className="w-4 shrink-0 text-center font-mono text-xs text-muted-foreground/70">
                {file.status?.trim()?.[0] ?? "-"}
              </span>
              <span className="truncate font-mono text-xs text-foreground/85">{file.path}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Codex-only patches can use a bare `@@` header. PatchDiff needs file headers.
 */
export function normalizePatch(path: string, diff: string): string {
  const trimmed = diff.trimStart()
  if (trimmed.length === 0 || trimmed.startsWith("diff ") || trimmed.startsWith("---")) {
    return diff
  }
  if (trimmed.startsWith("@@")) {
    return `--- a/${path}\n+++ b/${path}\n${diff}`
  }
  return diff
}

function countDiffMetrics(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1
    }
  }
  return { additions, deletions }
}
