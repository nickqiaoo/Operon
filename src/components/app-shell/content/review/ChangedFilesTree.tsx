import { useEffect, useMemo, useRef, useState } from "react"
import { useIntl } from "react-intl"
import { prepareFileTreeInput, type GitStatusEntry } from "@pierre/trees"
import { FileTree as PierreFileTree, useFileTree, useFileTreeSelection } from "@pierre/trees/react"
import { cn } from "@/lib/utils"
import { useResolvedMode } from "@/hooks/useResolvedMode"
import type { FileChange } from "./types"
import { PIERRE_GIT_STATUS } from "./constants"
import { FileFilterInput } from "@/components/workspace-browser/WorkspaceFileTree"

export interface ChangedFilesTreeProps {
  files: FileChange[]
  activePath: string | null
  onSelectPath: (path: string | null) => void
  className?: string
}

/**
 * Right-side file tree body (filter + paths only). Action chrome lives on the
 * shared full-width review header above both columns — same as Codex — so the
 * tree can slide without remounting buttons. Pierre's `useFileTree` reads its
 * initial path list ONCE — remount via `key` when the path set changes.
 * Initial expansion is `'open'` (matches codex).
 */
/** Our single-letter git status → Pierre's `GitStatus` enum (drives the
 *  A/M/U/R/D badge and the "dir contains changes" dot in the tree). */

/**
 * The filter's match: the query's characters appear in the path in order,
 * ignoring case, so `wbt` finds `WorkspaceBrowserTab.tsx` — the same feel as
 * the file browser's search, over a list that is already all here.
 */
function matchesFilter(path: string, query: string): boolean {
  const target = path.toLowerCase()
  let at = 0
  for (const char of query.toLowerCase()) {
    if (char === " ") continue
    at = target.indexOf(char, at)
    if (at === -1) return false
    at += 1
  }
  return true
}

export function ChangedFilesTree({ files: allFiles, activePath, onSelectPath, className }: ChangedFilesTreeProps) {
  const intl = useIntl()
  const [query, setQuery] = useState("")
  const trimmedQuery = query.trim()
  const files = useMemo(
    () => (trimmedQuery === "" ? allFiles : allFiles.filter((file) => matchesFilter(file.path, trimmedQuery))),
    [allFiles, trimmedQuery],
  )

  const allPaths = useMemo(() => {
    return [
      ...prepareFileTreeInput(
        files.map((file) => file.path),
        {
          flattenEmptyDirectories: true,
        },
      ).paths,
    ]
  }, [files])

  // Stable key so PierreTree only rebuilds when the *set* changes, not on
  // every selection toggle.
  const treeKey = useMemo(() => allPaths.join("|"), [allPaths])

  const gitStatus = useMemo<GitStatusEntry[]>(
    () =>
      files.map((f) => ({
        path: f.path,
        status: PIERRE_GIT_STATUS[f.status] ?? "modified",
      })),
    [files],
  )

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <FileFilterInput value={query} onChange={setQuery} />
      <div className="min-h-0 flex-1">
        {files.length === 0 && trimmedQuery !== "" ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            {intl.formatMessage({ id: "workspaceBrowser.noMatchingFiles", defaultMessage: "No matching files" })}
          </div>
        ) : (
          <ChangedFilesTreeInner
            key={treeKey}
            paths={allPaths}
            gitStatus={gitStatus}
            activePath={activePath}
            onSelectPath={onSelectPath}
          />
        )}
      </div>
    </div>
  )
}

export interface ChangedFilesTreeInnerProps {
  paths: string[]
  gitStatus: GitStatusEntry[]
  activePath: string | null
  onSelectPath: (path: string | null) => void
}

export function ChangedFilesTreeInner({
  paths,
  gitStatus,
  activePath,
  onSelectPath,
}: ChangedFilesTreeInnerProps) {
  const fileTreeOptions = useMemo(
    () => ({
      paths,
      gitStatus,
      initialExpansion: "open" as const,
      flattenEmptyDirectories: true,
      // The toolbar's filter input drives selection elsewhere; we don't want
      // Pierre's built-in search bar inside the tree.
      search: false,
      // Pierre only ships coloured glyphs in the `complete` set; `standard`
      // ignores `colored: true`. Use `complete` to get the orange `{}` for
      // JSON, blue `TS`, green `M↓`, … that match Codex's review tree.
      icons: { set: "complete" as const, colored: true },
      // Pierre tints the whole row (icon + filename + badge) with the git
      // status colour. Codex keeps filenames neutral and only colours the
      // A/M/U/R/D badge — do the same. Injected into an `unsafe` cascade
      // layer that beats Pierre's base styles.
      unsafeCSS: `
        [data-item-git-status] > [data-item-section='content'] { color: inherit; }
      `,
      initialSelectedPaths: activePath != null ? [activePath] : undefined,
    }),
    // Pierre reads options ONLY on first render — deps intentionally frozen.
    // The outer remount via `key` handles real changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const mode = useResolvedMode()
  const { model } = useFileTree(fileTreeOptions)
  const selectedPaths = useFileTreeSelection(model)
  const lastSelectedRef = useRef<string | null>(activePath)

  // Options are frozen after mount (see the deps note above), so status
  // changes on an unchanged path set (e.g. untracked → modified) must go
  // through the imperative API.
  useEffect(() => {
    model.setGitStatus(gitStatus)
  }, [model, gitStatus])

  useEffect(() => {
    if (selectedPaths.length === 0) return
    const next = selectedPaths[0]
    if (next == null || next.endsWith("/")) return
    if (lastSelectedRef.current === next) return
    lastSelectedRef.current = next
    onSelectPath(next)
  }, [selectedPaths, onSelectPath])

  return (
    <PierreFileTree
      model={model}
      style={
        {
          height: "100%",
          // Pierre renders in a shadow DOM and themes every color via
          // light-dark(), which follows the OS scheme — not our `.dark` class.
          // Pin color-scheme to our resolved mode so fg/border/selection/icons
          // track the app theme even when dark mode is forced on a light OS.
          colorScheme: mode,
          // Pierre's tree defaults to its own #f8f8f8 gray surface, which
          // reads darker than our app background. Pin it to the app surface so
          // the tree blends with the toolbar/filter row above it.
          // The ellipsis on a long name fades in over 100ms by default. The list
          // is virtualized, so scrolling keeps handing rows new names; for those
          // 100ms the overflowing text shows through, which reads as flicker.
          "--truncate-marker-fade-in-duration": "0ms",
          "--trees-bg-override": "var(--color-background)",
          "--trees-fg-override": "var(--color-foreground)",
          "--trees-selected-fg-override": "var(--color-foreground)",
          "--trees-focus-ring-color-override": "transparent",
          "--trees-focus-ring-width-override": "0px",
          "--trees-selected-focused-border-color-override": "transparent",
          "--trees-fg-muted-override": "var(--color-muted-foreground)",
          "--trees-padding-inline-override": "6px",
          "--trees-level-gap-override": "6px",
          "--trees-item-padding-x-override": "4px",
          "--trees-item-margin-x-override": "2px",
        } as React.CSSProperties
      }
    />
  )
}

// ---------------------------------------------------------------------------

