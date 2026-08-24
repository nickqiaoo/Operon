import { useMemo } from "react"
import { FormattedMessage } from "react-intl"
import { PatchDiff } from "@pierre/diffs/react"
import type { DiffLineAnnotation } from "@pierre/diffs"
import { FileDiff } from "lucide-react"
import { useThemeStore } from "@/stores/theme-store"
import { useEditorStore } from "@/stores/editor-store"
import { useIsMobile } from "@/hooks/useIsMobile"
import {
  createPierreDiffOptions,
  getDiffStats,
  normalizeUnifiedPatch,
} from "@shared/tool-rendering/diff"
import { useLineComments, type CommentMeta } from "./comments/useLineComments"

type DiffPreviewProps = {
  path: string
  content: string
}

const getBasename = (filePath: string) => {
  const normalized = filePath.replace(/[\\/]+$/, "")
  const parts = normalized.split(/[/\\]/)
  return parts[parts.length - 1] || normalized
}

export function DiffPreview({ path, content }: DiffPreviewProps) {
  const basename = useMemo(() => getBasename(path), [path])
  const isMobile = useIsMobile()
  const theme = useThemeStore((s) => s.theme)
  const themeType = useMemo(() => {
    if (theme === "system") return "system" as const
    return theme === "dark" ? ("dark" as const) : ("light" as const)
  }, [theme])

  // Codex patch format only has @@ hunks without --- / +++ file headers.
  // PatchDiff requires a complete unified diff, so prepend headers if missing.
  const normalizedContent = useMemo(() => {
    return normalizeUnifiedPatch(path, content)
  }, [content, path])
  const workspaceId = useEditorStore((s) => s.currentWorkspaceId)
  const { entries, renderCard, selectedLines, onGutterUtilityClick } = useLineComments({
    workspaceId,
    path,
    mode: "diff",
  })

  const lineAnnotations = useMemo<DiffLineAnnotation<CommentMeta>[]>(
    () =>
      entries.map((e) => ({
        side: e.side === "left" ? "deletions" : "additions",
        lineNumber: e.line,
        metadata: e.meta,
      })),
    [entries]
  )

  const diffOptions = useMemo(
    () => ({
      // Two code columns are unreadable at phone width — each ends up a few
      // characters wide and wraps every line. Annotations are positioned by
      // `{ side, lineNumber }`, which unified resolves the same way, so the
      // line comments keep working across the switch.
      ...createPierreDiffOptions(themeType, isMobile ? "unified" : "split"),
      enableGutterUtility: true,
      onGutterUtilityClick,
    }),
    [themeType, isMobile, onGutterUtilityClick]
  )

  const diffStats = useMemo(() => {
    return getDiffStats(content)
  }, [content])

  const hasDiffContent = content.trim().length > 0

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-3 py-2 border-b border-border/60 bg-muted/35">
        <div className="flex flex-col min-w-0">
          <div className="text-sm font-semibold truncate flex items-center gap-2">
            <FileDiff className="h-4 w-4 text-muted-foreground" />
            {basename}
            {(diffStats.additions > 0 || diffStats.deletions > 0) && (
              <span className="text-xs font-mono font-normal">
                {diffStats.additions > 0 && <span className="text-green-600">+{diffStats.additions}</span>}
                {diffStats.deletions > 0 && <span className="text-red-600 ml-1">-{diffStats.deletions}</span>}
              </span>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground truncate">{path}</div>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto code-scrollbar px-3 py-2">
        {hasDiffContent ? (
          <PatchDiff<CommentMeta>
            patch={normalizedContent}
            className="pierre-diff-file-view rounded-xl overflow-hidden text-sm"
            options={diffOptions}
            lineAnnotations={lineAnnotations}
            selectedLines={selectedLines}
            renderAnnotation={(annotation) => renderCard(annotation.metadata)}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
            <FormattedMessage id="editor.diff.empty" defaultMessage="No diff to display." />
          </div>
        )}
      </div>
    </div>
  )
}
