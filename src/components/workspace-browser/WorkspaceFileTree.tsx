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

/**
 * How long a directory load runs before its row shows a spinner. Local reads
 * finish well under this, so they never flash one; remote (web → tunnel) reads
 * can take long enough that an expand with no feedback looks frozen.
 */
const DIR_LOADING_DELAY_MS = 150

const DIR_LOADING_STYLE_ID = "operon-dir-loading"

/**
 * Style rules that swap each loading directory's chevron for a spinner.
 *
 * Pierre has no loading state for rows and only re-renders on model changes, so
 * the indicator is a stylesheet keyed on `data-item-path` inside the tree's
 * shadow root. Being CSS, it also follows the path when the virtualized list
 * hands that row to a different DOM node mid-scroll.
 */
const buildDirLoadingCss = (treeDirs: Iterable<string>): string => {
  const icons = Array.from(
    treeDirs,
    (dir) => `[data-type='item'][data-item-path="${CSS.escape(dir)}"] > [data-item-section='icon']`
  )
  if (icons.length === 0) return ""
  return `
${icons.join(",\n")} { position: relative; }
${icons.map((icon) => `${icon} > [data-icon-name='file-tree-icon-chevron']`).join(",\n")} { visibility: hidden; }
${icons.map((icon) => `${icon}::after`).join(",\n")} {
  content: "";
  position: absolute;
  inset: 0;
  margin: auto;
  width: 10px;
  height: 10px;
  box-sizing: border-box;
  border-radius: 50%;
  border: 1.5px solid var(--trees-fg-muted);
  border-right-color: transparent;
  animation: operon-dir-loading-spin 0.7s linear infinite;
}
@keyframes operon-dir-loading-spin { to { transform: rotate(360deg); } }
`
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
        // Seed the selected file; TreeInner reveals it after loading its parents.
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
      // Pierre rings whichever row has focus, so a mouse click leaves a dark
      // frame on the row. Keep the ring for keyboard navigation (`:focus-visible`)
      // and drop it when the row was focused by the pointer. Rows only carry
      // `:focus` when they hold DOM focus themselves, so the ring Pierre draws on
      // the active match while typing in search stays.
      unsafeCSS: `
        [data-type='item'][data-item-focused='true']:focus:not(:focus-visible)::before {
          outline-color: transparent;
        }
      `,
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

  /** In-flight loads per directory; a count because reveal and expand can overlap. */
  const loadingDirsRef = useRef<Map<string, number>>(new Map())

  const syncDirLoadingStyle = useCallback(() => {
    const shadowRoot = model.getFileTreeContainer()?.shadowRoot
    if (shadowRoot == null) return
    let style = shadowRoot.getElementById(DIR_LOADING_STYLE_ID)
    if (style == null) {
      style = document.createElement("style")
      style.id = DIR_LOADING_STYLE_ID
      shadowRoot.appendChild(style)
    }
    style.textContent = buildDirLoadingCss(loadingDirsRef.current.keys())
  }, [model])

  /** Show a spinner on the directory's row if its load outlasts the delay. */
  const trackDirLoading = useCallback(
    <T,>(treeDir: string, load: Promise<T>): Promise<T> => {
      let shown = false
      const timer = setTimeout(() => {
        shown = true
        const loading = loadingDirsRef.current
        loading.set(treeDir, (loading.get(treeDir) ?? 0) + 1)
        syncDirLoadingStyle()
      }, DIR_LOADING_DELAY_MS)
      const settle = () => {
        clearTimeout(timer)
        if (!shown) return
        const loading = loadingDirsRef.current
        const remaining = (loading.get(treeDir) ?? 1) - 1
        if (remaining > 0) loading.set(treeDir, remaining)
        else loading.delete(treeDir)
        syncDirLoadingStyle()
      }
      load.then(settle, settle)
      return load
    },
    [syncDirLoadingStyle]
  )

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
          trackDirLoading(path, loadDir(path))
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
  }, [model, loadDir, reconcile, trackDirLoading])

  // Surface file selections to the consumer. Declared before the reveal effect
  // below, which writes it to keep its own selection from echoing back.
  const selectedPaths = useFileTreeSelection(model)
  const lastSelectedRef = useRef<string | null>(selectedPath)

  // Follow the file on screen, wherever it was picked — this tree, the preview's
  // file strip, back/forward, a citation in chat — and also on first mount
  // (reopening the pane creates a closed tree). Load and expand its ancestors,
  // including directories hidden by flattening, then select it and scroll to it.
  useEffect(() => {
    if (selectedPath == null || !selectedPath.startsWith(`${rootPath}/`)) return
    const treePath = toTreePath(rootPath, selectedPath, false)
    lastSelectedRef.current = selectedPath
    let cancelled = false
    const reveal = async () => {
      const segments = treePath.split("/")
      for (let depth = 1; depth < segments.length; depth++) {
        const dir = `${segments.slice(0, depth).join("/")}/`
        const item = model.getItem(dir)
        const expanded = item != null && "isExpanded" in item && item.isExpanded()
        if (expanded && loadedDirsRef.current.has(dir)) continue
        const children = await trackDirLoading(dir, loadDir(dir))
        if (cancelled) return
        reconcile(dir, children)
        loadedDirsRef.current.add(dir)
        const loaded = model.getItem(dir)
        if (loaded != null && "expand" in loaded) loaded.expand()
      }
      if (cancelled) return
      for (const path of model.getSelectedPaths()) {
        if (path !== treePath) model.getItem(path)?.deselect()
      }
      const target = model.getItem(treePath)
      if (target != null && !target.isSelected()) target.select()
      model.scrollToPath(treePath, { focus: false, offset: "nearest" })
    }
    void reveal().catch((err) => {
      if (!cancelled) console.error("WorkspaceFileTree: failed to reveal", treePath, err)
    })
    return () => {
      cancelled = true
    }
  }, [model, rootPath, selectedPath, loadDir, reconcile, trackDirLoading])

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

  // Report only when the tree's selection itself changes. Consumers pass a fresh
  // `onSelectFile` every render; re-running on that would re-report the tree's
  // stale selection right after the file changed elsewhere (strip, back/forward)
  // and bounce the preview between the old and new file until the reveal above
  // caught up — ~50 full re-layouts per switch.
  // Pierre also re-emits the *unchanged* selection while the reveal effect
  // moves it, so compare against the tree's own previous selection too:
  // only a row that differs from what the tree last had is a user pick.
  const onSelectFileRef = useRef(onSelectFile)
  onSelectFileRef.current = onSelectFile
  const lastTreeSelectionRef = useRef<string | null>(null)
  useEffect(() => {
    const treePath = selectedPaths[0]
    if (treePath == null) return
    const previousTreePath = lastTreeSelectionRef.current
    lastTreeSelectionRef.current = treePath
    if (treePath === previousTreePath || isDirectoryPath(treePath)) return
    const absolutePath = toAbsolutePath(rootPath, treePath)
    if (lastSelectedRef.current === absolutePath) return
    lastSelectedRef.current = absolutePath
    onSelectFileRef.current(absolutePath)
  }, [selectedPaths, rootPath])

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
          // The ellipsis on a long name fades in over 100ms by default. The list
          // is virtualized, so scrolling keeps handing rows new names; for those
          // 100ms the overflowing text shows through, which reads as flicker.
          "--truncate-marker-fade-in-duration": "0ms",
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
