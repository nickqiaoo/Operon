import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { FormattedMessage, useIntl } from "react-intl"
import { useSelectedTextStore } from "@/stores/selected-text-store"
import { ChevronRight, Code, Eye, FileIcon, FileSearch, Loader2 } from "lucide-react"
import { FileDiff, File as PierreFile } from "@pierre/diffs/react"
import type { DiffLineAnnotation, FileDiffOptions, LineAnnotation } from "@pierre/diffs"
import { Button } from "@/components/ui/button"
import { MarkdownRenderer } from "@/components/ui/markdown-renderer"
import { MarkdownToc } from "@/components/ui/markdown-toc"
import { SelectionToolbar, type SelectionAction } from "@/components/ui/selection-toolbar"
import { api } from "@/lib/api"
import { getImageMediaType, readFileForPreview } from "@/lib/file-preview"
import { basename } from "@/lib/workspace-files"
import { useEditorStore } from "@/stores/editor-store"
import { useThemeStore } from "@/stores/theme-store"
import { createPierreDiffOptions, createPierreFileOptions } from "@shared/tool-rendering/diff"
import { useLineComments, type CommentMeta } from "@/components/editor/comments/useLineComments"
import { useAuthedObjectUrl } from "@/hooks/useAuthedObjectUrl"
import { isMacPlatform } from "@/lib/shortcuts/accelerator"
import { cn } from "@/lib/utils"
import { useFilePreviewDiffStore } from "@/stores/file-preview-diff-store"
import { ChangeNavigator, DiffBasePill } from "./DiffControls"
import { FindBar } from "./FindBar"
import { TOOLBAR_ICON_BUTTON, TOOLBAR_PILL } from "@/components/ui/toolbar-styles"
import { useFileBaseDiff } from "./useFileBaseDiff"
import { FIND_HIGHLIGHT_CSS, useTextFind, type FindOptions, type TextFindTarget } from "./useTextFind"

interface FilePreviewPaneProps {
  selectedPath: string | null
  /** Workspace root. When present, the header shows paths relative to it. */
  rootPath?: string | null
  /** 1-based source line to scroll to and highlight. */
  gotoLine?: number
  /** Changes whenever a new jump is requested, even to the same line. */
  gotoNonce?: number
  /** Optional control rendered at the far-right of the header (e.g. the desktop
   * tree-toggle / refresh / open-in-editor buttons). */
  rightAccessory?: ReactNode
  /** Optional control rendered at the far-left of the header (e.g. a mobile
   * "back" button). */
  leftAccessory?: ReactNode
  /**
   * Where the desktop file browser wants this file's controls: a toolbar row
   * spanning the preview and the tree. Given, the controls render there as
   * capsules (only while `active`) instead of in the pane's own header bar.
   * Null while that row is mounting.
   */
  toolbarSlot?: HTMLElement | null
  /** The toolbar's right-hand slot (find, outline), next to the tab's own buttons. */
  toolbarEndSlot?: HTMLElement | null
  /** Mark lines changed against the git comparison base (desktop browser). */
  gitChanges?: boolean
  /** Changing this re-reads the file from disk (manual refresh). */
  reloadNonce?: number
  /**
   * False while this pane is mounted but hidden behind another open file. Only
   * the active pane answers ⌘F and paints find highlights.
   */
  active?: boolean
  /**
   * Line comments and "Add to chat" — both feed the active workspace's chat.
   * Off where the file isn't a workspace's (the assistant's files).
   */
  workspaceTools?: boolean
  className?: string
}

type PreviewMode = "preview" | "source"

/**
 * File content preview — source files via pierre `<File>`, raster images via
 * `<img>`. Shared by the desktop {@link WorkspaceBrowserTab} and the mobile Files
 * screen so both render files identically; only the surrounding chrome differs.
 */
export function FilePreviewPane({
  selectedPath,
  rootPath,
  gotoLine,
  gotoNonce,
  rightAccessory,
  leftAccessory,
  toolbarSlot,
  toolbarEndSlot,
  gitChanges = false,
  reloadNonce,
  active = true,
  workspaceTools = true,
  className,
}: FilePreviewPaneProps) {
  const intl = useIntl()
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const secureImageUrl = useAuthedObjectUrl(__APP_TARGET__ === "web" ? imageUrl : null)
  const displayedImageUrl = __APP_TARGET__ === "web" ? secureImageUrl : imageUrl
  const [viewMode, setViewMode] = useState<PreviewMode>("source")
  const contentRef = useRef<HTMLDivElement | null>(null)
  const markdownRef = useRef<HTMLDivElement | null>(null)
  // Container for the selection toolbar. Covers both view modes — the actions
  // themselves are what differ.
  const previewRef = useRef<HTMLDivElement | null>(null)
  const findInputRef = useRef<HTMLInputElement | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState("")
  const [findOptions, setFindOptions] = useState<FindOptions>({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  })

  const imageMediaType = useMemo(
    () => (selectedPath != null ? getImageMediaType(selectedPath) : null),
    [selectedPath]
  )
  const isRasterImage = imageMediaType != null && imageMediaType !== "image/svg+xml"
  const isMarkdown = useMemo(
    () => selectedPath != null && isMarkdownPath(selectedPath),
    [selectedPath]
  )
  const displayPath = useMemo(
    () => (selectedPath != null ? getDisplayPath(rootPath, selectedPath) : null),
    [rootPath, selectedPath]
  )
  const commentPath = displayPath ?? selectedPath ?? ""
  const theme = useThemeStore((s) => s.theme)
  const themeType = theme === "system" ? "system" : theme === "dark" ? "dark" : "light"
  const workspaceId = useEditorStore((s) => s.currentWorkspaceId)

  const diffEnabled = useFilePreviewDiffStore((s) => s.enabled)
  const setDiffBase = useFilePreviewDiffStore((s) => s.setBase)
  const { base: diffBase, diff } = useFileBaseDiff({
    rootPath,
    // getDisplayPath hands the absolute path back for a file outside the root.
    relativePath: displayPath != null && displayPath !== selectedPath ? displayPath : null,
    contents: content,
    enabled: gitChanges && diffEnabled && !isRasterImage,
  })
  const diffChanges = diff.status === "ready" ? diff.changes : null
  // Rendered markdown has no lines to mark; the comparison is a source-view thing.
  const diffApplies = diff.status !== "off" && viewMode === "source"
  const showingDiff = diffApplies && diff.status === "ready" && diff.changes.length > 0
  const [activeChange, setActiveChange] = useState(-1)
  useEffect(() => setActiveChange(-1), [diff])

  const { entries, renderCard, selectedLines, onGutterUtilityClick } = useLineComments({
    workspaceId,
    path: commentPath,
    mode: showingDiff ? "diff" : "file",
  })
  const selectionActions = useMemo<SelectionAction[]>(
    () => !workspaceTools ? [] : [
      {
        key: "add-to-chat",
        label: <FormattedMessage id="selection.addToChat" defaultMessage="Add to chat" />,
        onSelect: ({ text, range }) => {
          useSelectedTextStore.getState().add({
            id: crypto.randomUUID(),
            workspaceId,
            path: commentPath,
            location: lineRangeFromSelection(range),
            text,
            createdAt: Date.now(),
          })
        },
      },
    ],
    [commentPath, workspaceId, workspaceTools]
  )
  const lineAnnotations = useMemo<LineAnnotation<CommentMeta>[]>(
    () => !workspaceTools ? [] : entries.map((entry) => ({ lineNumber: entry.line, metadata: entry.meta })),
    [entries, workspaceTools]
  )
  const diffLineAnnotations = useMemo<DiffLineAnnotation<CommentMeta>[]>(
    () => !workspaceTools ? [] : entries.map((entry) => ({
      side: entry.side === "left" ? "deletions" : "additions",
      lineNumber: entry.line,
      metadata: entry.meta,
    })),
    [entries, workspaceTools]
  )
  const diffOptions = useMemo<FileDiffOptions<CommentMeta>>(
    () => ({
      ...createPierreDiffOptions(themeType, "unified"),
      disableFileHeader: true,
      // The whole file, changed lines marked in place — not hunks of context.
      expandUnchanged: true,
      enableGutterUtility: workspaceTools,
      lineHoverHighlight: "line" as const,
      onGutterUtilityClick,
      unsafeCSS: FIND_HIGHLIGHT_CSS,
    }),
    [themeType, onGutterUtilityClick, workspaceTools]
  )
  const fileOptions = useMemo(
    () => ({
      ...createPierreFileOptions(themeType),
      enableGutterUtility: workspaceTools,
      lineHoverHighlight: "line" as const,
      onGutterUtilityClick,
      // The source view lives in a shadow root, out of reach of the document's
      // `::highlight()` rules.
      unsafeCSS: FIND_HIGHLIGHT_CSS,
    }),
    [themeType, onGutterUtilityClick, workspaceTools]
  )
  const previewFile = useMemo(
    () => ({
      name: displayPath ?? (selectedPath != null ? basename(selectedPath) : ""),
      contents: content ?? "",
    }),
    [content, displayPath, selectedPath]
  )
  const showMarkdownToggle = isMarkdown && content != null && !isRasterImage

  // Load text content (skips raster images — those go through getFileUrl).
  useEffect(() => {
    if (selectedPath == null) {
      setContent(null)
      setError(null)
      return
    }
    if (isRasterImage) {
      setContent(null)
      return
    }
    let cancelled = false
    setContent(null)
    setError(null)
    readFileForPreview(selectedPath)
      .then((c) => {
        if (cancelled) return
        setContent(c)
      })
      .catch((err) => {
        if (cancelled) return
        console.error("FilePreviewPane: failed to read", selectedPath, err)
        setError(err instanceof Error ? err.message : "Failed to read file")
      })
    return () => {
      cancelled = true
    }
    // reloadNonce re-reads the file when the refresh button is clicked.
  }, [selectedPath, isRasterImage, reloadNonce])

  // Load image URL.
  useEffect(() => {
    if (!isRasterImage || selectedPath == null) {
      setImageUrl(null)
      return
    }
    let cancelled = false
    setImageUrl(null)
    api
      .getFileUrl(selectedPath)
      .then((url) => {
        if (!cancelled) setImageUrl(url)
      })
      .catch((err) => {
        if (cancelled) return
        console.error("FilePreviewPane: failed to resolve image", err)
        setError("Unable to load image")
      })
    return () => {
      cancelled = true
    }
  }, [isRasterImage, selectedPath, reloadNonce])

  useEffect(() => {
    setViewMode(selectedPath != null && !isRasterImage && isMarkdown ? "preview" : "source")
  }, [selectedPath, isRasterImage, isMarkdown])

  // Line jumps and line comments operate on source rows, not rendered markdown.
  // Kept apart from the default above so a pane losing its jump (another file
  // became active) doesn't throw away the view mode the user picked.
  useEffect(() => {
    if (gotoLine != null) setViewMode("source")
  }, [gotoLine, gotoNonce])

  const showingMarkdownPreview = isMarkdown && viewMode === "preview"
  const getFindTarget = useCallback((): TextFindTarget | null => {
    if (showingMarkdownPreview) {
      const root = markdownRef.current
      if (root == null) return null
      // Diagram labels and copy/zoom buttons aren't part of the document text.
      return { root, accept: (text) => text.parentElement?.closest("svg, button") == null }
    }
    const root = contentRef.current?.querySelector(".pierre-diff-file-view")?.shadowRoot
    if (root == null) return null
    // Only the code column — not the line-number gutter.
    return { root, accept: (text) => text.parentElement?.closest("[data-content]") != null }
  }, [showingMarkdownPreview])
  const findContentKey = useMemo(() => ({}), [content, viewMode, reloadNonce, showingDiff])
  const find = useTextFind({
    getTarget: getFindTarget,
    enabled: active && findOpen,
    query: findQuery,
    options: findOptions,
    contentKey: findContentKey,
  })

  const openFind = useCallback(() => {
    const selection = window.getSelection()
    const selected = selection?.toString() ?? ""
    const anchor = selection?.anchorNode ?? null
    // Seed with a short single-line selection made inside this preview.
    if (
      selected.trim().length > 0 &&
      selected.length <= 200 &&
      !selected.includes("\n") &&
      anchor != null &&
      previewRef.current?.contains(anchor)
    ) {
      setFindQuery(selected)
    }
    setFindOpen(true)
    requestAnimationFrame(() => {
      findInputRef.current?.focus()
      findInputRef.current?.select()
    })
  }, [])

  const closeFind = useCallback(() => {
    setFindOpen(false)
    previewRef.current?.focus({ preventScroll: true })
  }, [])

  // ⌘F / Ctrl+F while focus is anywhere in this file browser — the preview
  // itself or the tree beside it (`data-find-scope`). ⌘G / ⇧⌘G step matches.
  useEffect(() => {
    if (!active || selectedPath == null || isRasterImage) return
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = isMacPlatform() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (!mod || e.altKey) return
      const key = e.key.toLowerCase()
      if (key !== "f" && key !== "g") return
      const pane = previewRef.current
      if (pane == null || !(e.target instanceof Node)) return
      const scope = pane.closest("[data-find-scope]") ?? pane
      if (!scope.contains(e.target)) return
      if (key === "f") {
        if (e.shiftKey) return
        e.preventDefault()
        openFind()
      } else if (findOpen) {
        e.preventDefault()
        if (e.shiftKey) find.previous()
        else find.next()
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [active, selectedPath, isRasterImage, findOpen, find.next, find.previous, openFind])

  useEffect(() => {
    if (gotoLine == null || isRasterImage || content == null || viewMode !== "source") return

    let raf = 0
    let tries = 0
    const tryScroll = () => {
      const host = contentRef.current?.querySelector(".pierre-diff-file-view")
      const root: ParentNode | null | undefined = host?.shadowRoot ?? contentRef.current
      // In the comparison, a removed row can carry the same (old) number.
      const el = root?.querySelector<HTMLElement>(
        `[data-line="${gotoLine}"]:not([data-line-type="change-deletion"])`
      )
      if (el) {
        el.scrollIntoView({ block: "center" })
        el.style.transition = "background-color 200ms ease"
        el.style.backgroundColor = "var(--code-line, rgba(120,150,255,0.15))"
        window.setTimeout(() => {
          el.style.backgroundColor = ""
        }, 1200)
        return
      }
      if (tries++ < 20) raf = requestAnimationFrame(tryScroll)
    }
    raf = requestAnimationFrame(tryScroll)
    return () => cancelAnimationFrame(raf)
  }, [content, gotoLine, gotoNonce, isRasterImage, viewMode, showingDiff])

  const goToChange = (index: number) => {
    const change = diffChanges?.[index]
    if (change == null) return
    setActiveChange(index)
    const root = contentRef.current?.querySelector(".pierre-diff-file-view")?.shadowRoot
    // Unified view lists a block's removed rows first, so that's where it starts.
    const selector =
      change.deletionLine != null
        ? `[data-line-type="change-deletion"][data-line="${change.deletionLine}"]`
        : `[data-line-type="change-addition"][data-line="${change.additionLine}"]`
    root?.querySelector<HTMLElement>(selector)?.scrollIntoView({ block: "center" })
  }

  const showToc = showMarkdownToggle && viewMode === "preview" && content != null
  const markdownControls = showMarkdownToggle ? (
    <>
      {showToc && <MarkdownToc contentRef={markdownRef} content={content} />}
      <MarkdownViewToggle value={viewMode} onChange={setViewMode} />
    </>
  ) : null

  // The desktop browser's toolbar row, portaled there while this pane is the
  // one on screen. Left: what the content shows (rendered / source, the
  // comparison). No breadcrumb: the panel tab and the open-files strip already
  // name the file, and a third copy was just noise.
  const onToolbar = active && selectedPath != null
  const toolbarControls =
    toolbarSlot != null && onToolbar
      ? createPortal(
          <>
            {diffApplies && diffChanges != null && diffChanges.length > 0 && (
              <ChangeNavigator
                count={diffChanges.length}
                activeIndex={activeChange}
                onNavigate={goToChange}
              />
            )}
            {diffApplies && diffBase.base != null && rootPath != null && (
              <DiffBasePill
                rootPath={rootPath}
                base={diffBase.base}
                onBaseChange={(base) => setDiffBase(rootPath, base)}
              />
            )}
            {showMarkdownToggle && (
              <MarkdownViewToggle value={viewMode} onChange={setViewMode} capsule />
            )}
          </>,
          toolbarSlot
        )
      : null
  // Right: tools that act on the file — find, outline.
  const toolbarEndControls =
    toolbarEndSlot != null && onToolbar
      ? createPortal(
          <>
            {!isRasterImage && content != null && (
              <button
                type="button"
                onClick={openFind}
                aria-label={intl.formatMessage({ id: "filePreview.find", defaultMessage: "Find in file" })}
                title={intl.formatMessage({ id: "filePreview.find", defaultMessage: "Find in file" })}
                className={TOOLBAR_ICON_BUTTON}
              >
                <FileSearch className="h-3.5 w-3.5" />
              </button>
            )}
            {showToc && (
              <MarkdownToc contentRef={markdownRef} content={content} buttonClassName={TOOLBAR_ICON_BUTTON} />
            )}
          </>,
          toolbarEndSlot
        )
      : null

  if (selectedPath == null) {
    return (
      <div className={`flex flex-col ${className ?? ""}`}>
        {(leftAccessory != null || rightAccessory != null) && (
          <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border/50 px-2">
            {leftAccessory}
            {rightAccessory != null && (
              <div className="ml-auto flex shrink-0 items-center gap-0.5">{rightAccessory}</div>
            )}
          </div>
        )}
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          Select a file to preview
        </div>
      </div>
    )
  }

  return (
    <div className={`flex flex-col ${className ?? ""}`}>
      {toolbarControls}
      {toolbarEndControls}
      {toolbarSlot === undefined && (
        <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border/50 pl-3 pr-2 text-xs text-muted-foreground">
          {leftAccessory}
          <FileIcon className="h-3.5 w-3.5 shrink-0" />
          {displayPath != null && (
            <PathBreadcrumb path={displayPath} title={selectedPath} />
          )}
          {(showMarkdownToggle || rightAccessory != null) && (
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {markdownControls}
              {rightAccessory}
            </div>
          )}
        </div>
      )}
      <div ref={previewRef} tabIndex={-1} className="relative min-h-0 flex-1 outline-none">
        <SelectionToolbar containerRef={previewRef} actions={selectionActions} />
        {findOpen && !isRasterImage && content != null && (
          <FindBar
            ref={findInputRef}
            query={findQuery}
            onQueryChange={setFindQuery}
            options={findOptions}
            onOptionsChange={setFindOptions}
            find={find}
            onClose={closeFind}
          />
        )}
        {error != null ? (
          <div className="flex h-full items-center justify-center px-4 text-xs text-destructive">
            {error}
          </div>
        ) : isRasterImage ? (
          displayedImageUrl != null ? (
            <div className="flex h-full items-center justify-center overflow-auto bg-muted/20 p-4">
              <img
                src={displayedImageUrl}
                alt={basename(selectedPath)}
                className="max-h-full max-w-full object-contain"
              />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading image…
            </div>
          )
        ) : content == null ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : showingMarkdownPreview ? (
          <div className="h-full w-full overflow-auto code-scrollbar">
            <div ref={markdownRef} className="min-w-0 px-4 py-5 sm:px-6 sm:py-6">
              <MarkdownRenderer content={content} />
            </div>
          </div>
        ) : (
          <div ref={contentRef} className="h-full w-full overflow-auto code-scrollbar">
            {showingDiff && diff.status === "ready" ? (
              <FileDiff<CommentMeta>
                fileDiff={diff.fileDiff}
                options={diffOptions}
                lineAnnotations={diffLineAnnotations}
                selectedLines={workspaceTools ? selectedLines : null}
                renderAnnotation={(annotation) => renderCard(annotation.metadata)}
                className="pierre-diff-file-view pierre-file-preview-view"
              />
            ) : (
              <PierreFile<CommentMeta>
                file={previewFile}
                options={fileOptions}
                lineAnnotations={lineAnnotations}
                selectedLines={workspaceTools ? selectedLines : null}
                renderAnnotation={(annotation) => renderCard(annotation.metadata)}
                className="pierre-diff-file-view pierre-file-preview-view"
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function getDisplayPath(rootPath: string | null | undefined, selectedPath: string): string {
  if (!rootPath) return selectedPath
  const normalizedRoot = normalizePath(rootPath).replace(/\/+$/, "")
  const normalizedSelected = normalizePath(selectedPath)
  return normalizedSelected.startsWith(`${normalizedRoot}/`)
    ? normalizedSelected.slice(normalizedRoot.length + 1)
    : selectedPath
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/")
}

function isMarkdownPath(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path)
}

function MarkdownViewToggle({
  value,
  onChange,
  capsule = false,
}: {
  value: PreviewMode
  onChange: (value: PreviewMode) => void
  /** Sit in the desktop toolbar's capsule row. */
  capsule?: boolean
}) {
  return (
    <div
      className={cn(
        "flex items-center overflow-hidden [&>button]:h-full",
        capsule ? TOOLBAR_PILL : "h-7 rounded-md border border-border/50 bg-muted/20"
      )}
    >
      <Button
        type="button"
        variant={value === "preview" ? "secondary" : "ghost"}
        size="sm"
        aria-label="Show markdown preview"
        title="Preview"
        className="h-7 gap-1 rounded-none px-2 text-[11px]"
        onClick={() => onChange("preview")}
      >
        <Eye className="h-3.5 w-3.5" />
        <span>Preview</span>
      </Button>
      <div className="h-4 w-px bg-border/70" />
      <Button
        type="button"
        variant={value === "source" ? "secondary" : "ghost"}
        size="sm"
        aria-label="Show markdown source"
        title="Source"
        className="h-7 gap-1 rounded-none px-2 text-[11px]"
        onClick={() => onChange("source")}
      >
        <Code className="h-3.5 w-3.5" />
        <span>Source</span>
      </Button>
    </div>
  )
}

function PathBreadcrumb({ path, title }: { path: string; title: string }) {
  const parts = path.split("/").filter(Boolean)
  if (parts.length === 0) return <span className="min-w-0 truncate" title={title}>{path}</span>
  return (
    // Pinned to the end: when it doesn't fit, the leading folders slide off the
    // left edge (as in Codex) and the file name stays whole.
    <div className="flex min-w-0 items-center justify-end gap-1 overflow-hidden" title={title}>
      {parts.map((part, index) => {
        const isLast = index === parts.length - 1
        return (
          <span key={`${part}-${index}`} className="flex shrink-0 items-center gap-1">
            <span
              className={
                isLast
                  ? "whitespace-nowrap font-medium text-foreground"
                  : "whitespace-nowrap text-muted-foreground"
              }
            >
              {part}
            </span>
            {!isLast && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />}
          </span>
        )
      })}
    </div>
  )
}

/**
 * Best-effort line range for a selection, as `12` or `12-18`.
 *
 * Pierre tags each rendered row with `data-line`, so a selection in the source
 * view can say where it came from. The rendered markdown view has no lines at
 * all, and a selection can also start or end in the gutter — hence best-effort:
 * this only ever decorates the chip's label, so `undefined` degrades to the
 * bare filename rather than mislabelling anything.
 */
function lineRangeFromSelection(range: Range): string | undefined {
  const lineOf = (node: Node | null): number | undefined => {
    const element =
      node == null
        ? null
        : node.nodeType === Node.ELEMENT_NODE
          ? (node as HTMLElement)
          : node.parentElement
    const raw = element?.closest<HTMLElement>("[data-line]")?.dataset.line
    if (raw == null) return undefined
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  const start = lineOf(range.startContainer)
  const end = lineOf(range.endContainer)
  if (start == null) return end == null ? undefined : String(end)
  if (end == null || end === start) return String(start)
  return `${Math.min(start, end)}-${Math.max(start, end)}`
}
