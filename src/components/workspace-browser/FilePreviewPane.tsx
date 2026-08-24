import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ChevronRight, Code, Eye, FileIcon } from "lucide-react"
import { File as PierreFile } from "@pierre/diffs/react"
import type { LineAnnotation } from "@pierre/diffs"
import { Button } from "@/components/ui/button"
import { MarkdownRenderer } from "@/components/ui/markdown-renderer"
import { ScrollArea } from "@/components/ui/scroll-area"
import { api } from "@/lib/api"
import { getImageMediaType, readFileForPreview } from "@/lib/file-preview"
import { basename } from "@/lib/workspace-files"
import { useEditorStore } from "@/stores/editor-store"
import { useThemeStore } from "@/stores/theme-store"
import { createPierreFileOptions } from "@shared/tool-rendering/diff"
import { useLineComments, type CommentMeta } from "@/components/editor/comments/useLineComments"
import { useAuthedObjectUrl } from "@/hooks/useAuthedObjectUrl"

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
  /** Changing this re-reads the file from disk (manual refresh). */
  reloadNonce?: number
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
  reloadNonce,
  className,
}: FilePreviewPaneProps) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const secureImageUrl = useAuthedObjectUrl(__APP_TARGET__ === "web" ? imageUrl : null)
  const displayedImageUrl = __APP_TARGET__ === "web" ? secureImageUrl : imageUrl
  const [viewMode, setViewMode] = useState<PreviewMode>("source")
  const contentRef = useRef<HTMLDivElement | null>(null)

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
  const { entries, renderCard, selectedLines, onGutterUtilityClick } = useLineComments({
    workspaceId,
    path: commentPath,
    mode: "file",
  })
  const lineAnnotations = useMemo<LineAnnotation<CommentMeta>[]>(
    () => entries.map((entry) => ({ lineNumber: entry.line, metadata: entry.meta })),
    [entries]
  )
  const fileOptions = useMemo(
    () => ({
      ...createPierreFileOptions(themeType),
      enableGutterUtility: true,
      lineHoverHighlight: "line" as const,
      onGutterUtilityClick,
    }),
    [themeType, onGutterUtilityClick]
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
    if (selectedPath == null || isRasterImage) {
      setViewMode("source")
      return
    }

    // Line jumps and line comments operate on source rows, not rendered markdown.
    if (gotoLine != null) {
      setViewMode("source")
      return
    }

    setViewMode(isMarkdown ? "preview" : "source")
  }, [selectedPath, isRasterImage, isMarkdown, gotoLine, gotoNonce])

  useEffect(() => {
    if (gotoLine == null || isRasterImage || content == null || viewMode !== "source") return

    let raf = 0
    let tries = 0
    const tryScroll = () => {
      const host = contentRef.current?.querySelector(".pierre-diff-file-view")
      const root: ParentNode | null | undefined = host?.shadowRoot ?? contentRef.current
      const el = root?.querySelector<HTMLElement>(`[data-line="${gotoLine}"]`)
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
  }, [content, gotoLine, gotoNonce, isRasterImage, viewMode])

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
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border/50 pl-3 pr-2 text-xs text-muted-foreground">
        {leftAccessory}
        <FileIcon className="h-3.5 w-3.5 shrink-0" />
        {displayPath != null && (
          <PathBreadcrumb path={displayPath} title={selectedPath} />
        )}
        {(showMarkdownToggle || rightAccessory != null) && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {showMarkdownToggle && (
              <MarkdownViewToggle value={viewMode} onChange={setViewMode} />
            )}
            {rightAccessory}
          </div>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
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
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Loading image…
            </div>
          )
        ) : content == null ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            Loading…
          </div>
        ) : isMarkdown && viewMode === "preview" ? (
          // `[&>div]:!block` defeats the radix viewport's inner `display:table`
          // wrapper, which otherwise sizes to content instead of to the pane.
          <ScrollArea className="h-full w-full" viewportClassName="[&>div]:!block">
            <div className="min-w-0 px-5 py-5 sm:px-8 sm:py-6">
              <MarkdownRenderer content={content} />
            </div>
          </ScrollArea>
        ) : (
          <div ref={contentRef} className="h-full w-full overflow-auto code-scrollbar">
            <PierreFile<CommentMeta>
              file={previewFile}
              options={fileOptions}
              lineAnnotations={lineAnnotations}
              selectedLines={selectedLines}
              renderAnnotation={(annotation) => renderCard(annotation.metadata)}
              className="pierre-diff-file-view pierre-file-preview-view"
            />
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
}: {
  value: PreviewMode
  onChange: (value: PreviewMode) => void
}) {
  return (
    <div className="flex h-7 items-center overflow-hidden rounded-md border border-border/50 bg-muted/20">
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
    <div className="flex min-w-0 items-center gap-1 overflow-hidden" title={title}>
      {parts.map((part, index) => {
        const isLast = index === parts.length - 1
        return (
          <span key={`${part}-${index}`} className="flex min-w-0 items-center gap-1">
            <span
              className={
                isLast
                  ? "min-w-0 truncate font-medium text-foreground"
                  : "min-w-0 truncate text-muted-foreground"
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
