import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  FileTree as PierreFileTree,
  useFileTree,
  useFileTreeSelection,
} from "@pierre/trees/react"
import type { FileTreeBatchOperation } from "@pierre/trees"
import { useQueryClient } from "@tanstack/react-query"
import {
  isDirectoryPath,
  readDirAsTreePaths,
  toAbsolutePath,
  toTreePath,
} from "@/lib/workspace-files"
import {
  WORKSPACE_DIR_STALE_MS,
  workspaceDirKeys,
} from "@/lib/workspace-dir-queries"
import { useResolvedMode } from "@/hooks/useResolvedMode"

/** True when `candidate` is a direct child of tree dir `treeDir` ("" = root). */
const isImmediateChild = (treeDir: string, candidate: string): boolean => {
  if (candidate === treeDir) return false
  if (treeDir !== "" && !candidate.startsWith(treeDir)) return false
  const rest = candidate.slice(treeDir.length).replace(/\/+$/, "")
  return rest.length > 0 && !rest.includes("/")
}

export interface WorkspaceFileTreeHandle {
  refresh: () => void
}

interface WorkspaceFileTreeProps {
  rootPath: string
  /** Absolute path of the currently-open file (expands + highlights it). */
  selectedPath: string | null
  /** Called with the absolute path when a file (not a directory) is selected. */
  onSelectFile: (absolutePath: string) => void
  /** Lets a parent's refresh button drive the tree's in-place reload. */
  apiRef?: React.MutableRefObject<WorkspaceFileTreeHandle | null>
  className?: string
}

/**
 * The directory tree half of the workspace browser, extracted so the desktop
 * {@link WorkspaceBrowserTab} and the mobile Files screen share one tree
 * implementation (lazy-load on expand, reconcile on refresh, Pierre theming).
 * Selection is surfaced via {@link onSelectFile}; the consumer decides what to
 * do with it (desktop opens a tab, mobile pushes a preview screen).
 */
export function WorkspaceFileTree({
  rootPath,
  selectedPath,
  onSelectFile,
  apiRef,
  className,
}: WorkspaceFileTreeProps) {
  const [initialPaths, setInitialPaths] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  useEffect(() => {
    let cancelled = false
    setInitialPaths(null)
    setError(null)
    // Root listing goes through the query cache (treeDir "") like every other
    // directory, so the manual refresh can invalidate + re-read it too.
    queryClient
      .fetchQuery({
        queryKey: workspaceDirKeys.dir(rootPath, ""),
        queryFn: () => readDirAsTreePaths(rootPath, rootPath),
        staleTime: WORKSPACE_DIR_STALE_MS,
      })
      .then((paths) => {
        if (cancelled) return
        // Include selectedPath in the initial set so it shows expanded.
        const merged = new Set(paths)
        if (selectedPath != null && selectedPath.startsWith(rootPath)) {
          merged.add(toTreePath(rootPath, selectedPath, false))
        }
        setInitialPaths(Array.from(merged))
      })
      .catch((err) => {
        if (cancelled) return
        console.error("WorkspaceFileTree: failed to load root", err)
        setError(err instanceof Error ? err.message : "Failed to load directory")
      })
    return () => {
      cancelled = true
    }
    // selectedPath isn't a dep — we don't reload the tree on every selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, queryClient])

  if (error != null) {
    return (
      <div className={`flex items-center justify-center px-4 text-xs text-destructive ${className ?? ""}`}>
        {error}
      </div>
    )
  }

  if (initialPaths == null) {
    return (
      <div className={`flex items-center justify-center text-xs text-muted-foreground ${className ?? ""}`}>
        Loading…
      </div>
    )
  }

  return (
    <TreeInner
      key={rootPath}
      rootPath={rootPath}
      initialPaths={initialPaths}
      selectedPath={selectedPath}
      onSelectFile={onSelectFile}
      apiRef={apiRef}
      className={className}
    />
  )
}

interface TreeInnerProps {
  rootPath: string
  /** Already loaded — caller guarantees non-null. */
  initialPaths: string[]
  selectedPath: string | null
  onSelectFile: (absolutePath: string) => void
  apiRef?: React.MutableRefObject<WorkspaceFileTreeHandle | null>
  className?: string
}

/**
 * Pierre's useFileTree creates the model exactly once with the initial options.
 * So this stays unmounted until initialPaths are ready (the parent gates it),
 * otherwise the model starts with an empty path list and never recovers.
 */
function TreeInner({
  rootPath,
  initialPaths,
  selectedPath,
  onSelectFile,
  apiRef,
  className,
}: TreeInnerProps) {
  const queryClient = useQueryClient()
  /** All paths currently in the model (for membership check). */
  const knownPathsRef = useRef<Set<string>>(new Set(initialPaths))
  /** Directories currently expanded and loaded (root "" loads with initialPaths). */
  const loadedDirsRef = useRef<Set<string>>(new Set([""]))

  const fileTreeOptions = useMemo(
    () => ({
      paths: initialPaths,
      initialExpansion: "closed" as const,
      flattenEmptyDirectories: true,
      search: true,
      // Pierre only renders coloured glyphs in the `complete` set.
      icons: { set: "complete" as const, colored: true },
      initialSelectedPaths:
        selectedPath != null && selectedPath.startsWith(rootPath)
          ? [toTreePath(rootPath, selectedPath, false)]
          : undefined,
    }),
    // Pierre reads options ONLY at first render — these deps are intentionally
    // frozen. Remounting via the `key={rootPath}` on the parent handles
    // root changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const mode = useResolvedMode()
  const { model } = useFileTree(fileTreeOptions)

  /** Read a directory's immediate children through the query cache. */
  const loadDir = useCallback(
    (treeDir: string) => {
      const absoluteDir =
        treeDir === "" ? rootPath : toAbsolutePath(rootPath, treeDir)
      return queryClient.fetchQuery({
        queryKey: workspaceDirKeys.dir(rootPath, treeDir),
        queryFn: () => readDirAsTreePaths(rootPath, absoluteDir),
        staleTime: WORKSPACE_DIR_STALE_MS,
      })
    },
    [queryClient, rootPath]
  )

  /** Apply a fresh child listing to the model: add new, remove vanished. */
  const reconcile = useCallback(
    (treeDir: string, freshPaths: string[]) => {
      const known = knownPathsRef.current
      const fresh = new Set(freshPaths)
      const additions = freshPaths.filter((p) => !known.has(p))
      const removals = Array.from(known).filter(
        (p) => isImmediateChild(treeDir, p) && !fresh.has(p)
      )
      if (additions.length === 0 && removals.length === 0) return

      const ops: FileTreeBatchOperation[] = [
        ...additions.map((path) => ({ type: "add" as const, path })),
        ...removals.map((path) => ({
          type: "remove" as const,
          path,
          recursive: true,
        })),
      ]
      model.batch(ops)

      for (const p of additions) known.add(p)
      for (const removed of removals) {
        known.delete(removed)
        loadedDirsRef.current.delete(removed)
        if (!isDirectoryPath(removed)) continue
        // Drop anything we tracked beneath a removed directory.
        for (const k of Array.from(known)) {
          if (k.startsWith(removed)) {
            known.delete(k)
            loadedDirsRef.current.delete(k)
          }
        }
      }
    },
    [model]
  )

  // Lazy-load on expand; a collapsed dir re-fetches when expanded again (the
  // 5s staleTime keeps a quick re-expand cache-cheap).
  useEffect(() => {
    const unsubscribe = model.subscribe(() => {
      for (const path of Array.from(knownPathsRef.current)) {
        if (!isDirectoryPath(path)) continue
        const item = model.getItem(path)
        const expanded =
          item != null && "isExpanded" in item && item.isExpanded()
        const loaded = loadedDirsRef.current.has(path)
        if (expanded && !loaded) {
          loadedDirsRef.current.add(path)
          loadDir(path)
            .then((children) => reconcile(path, children))
            .catch((err) => {
              console.error("WorkspaceFileTree: failed to load", path, err)
              loadedDirsRef.current.delete(path)
            })
        } else if (!expanded && loaded) {
          loadedDirsRef.current.delete(path)
        }
      }
    })
    return unsubscribe
  }, [model, loadDir, reconcile])

  // Manual refresh: invalidate this root's directory cache, then re-read the
  // root + every currently-expanded directory and reconcile in place (keeps
  // expansion + selection). Not watcher-driven — matches codex's file tree.
  useEffect(() => {
    if (apiRef == null) return
    const refresh = () => {
      void queryClient.invalidateQueries({
        queryKey: workspaceDirKeys.all(rootPath),
      })
      const dirs = new Set<string>([""])
      for (const dir of loadedDirsRef.current) dirs.add(dir)
      for (const treeDir of dirs) {
        loadDir(treeDir)
          .then((children) => reconcile(treeDir, children))
          .catch((err) =>
            console.error("WorkspaceFileTree: refresh failed", treeDir, err)
          )
      }
    }
    apiRef.current = { refresh }
    return () => {
      if (apiRef.current?.refresh === refresh) apiRef.current = null
    }
  }, [apiRef, queryClient, rootPath, loadDir, reconcile])

  // Surface file selections to the consumer.
  const selectedPaths = useFileTreeSelection(model)
  const lastSelectedRef = useRef<string | null>(selectedPath)
  useEffect(() => {
    if (selectedPaths.length === 0) return
    const treePath = selectedPaths[0]
    if (treePath == null || isDirectoryPath(treePath)) return
    const absolutePath = toAbsolutePath(rootPath, treePath)
    if (lastSelectedRef.current === absolutePath) return
    lastSelectedRef.current = absolutePath
    onSelectFile(absolutePath)
  }, [selectedPaths, rootPath, onSelectFile])

  return (
    <PierreFileTree
      model={model}
      // Tighten the default Codex-tree layout. Pierre's host element exposes
      // these CSS variables; reducing them brings the chevron up against the
      // file name (default 16px outer inset + 8px level gap leaves a wide
      // empty band on the left, especially in a narrow side panel).
      style={
        {
          height: "100%",
          // Pierre themes via light-dark() (follows the OS, not our `.dark`
          // class); pin color-scheme to our resolved mode so colors track the
          // app theme, then match the app surface instead of Pierre's #f8f8f8.
          colorScheme: mode,
          "--trees-bg-override": "var(--color-background)",
          "--trees-fg-override": "var(--color-foreground)",
          "--trees-selected-fg-override": "var(--color-foreground)",
          // Pierre outlines the focused row in its accent blue. The selected row
          // already reads from its background fill, so drop the ring on it and
          // let keyboard focus use our theme ring instead of pierre's blue.
          "--trees-selected-focused-border-color-override": "transparent",
          "--trees-focus-ring-color-override": "var(--color-ring)",
          "--trees-fg-muted-override": "var(--color-muted-foreground)",
          "--trees-padding-inline-override": "6px",
          "--trees-level-gap-override": "6px",
          "--trees-item-padding-x-override": "4px",
          "--trees-item-margin-x-override": "2px",
        } as React.CSSProperties
      }
      className={className}
    />
  )
}
