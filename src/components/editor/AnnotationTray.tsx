import { useMemo } from "react"
import { useIntl, type IntlShape } from "react-intl"
import type { FileUIPart } from "ai"
import { X, SlidersHorizontal } from "lucide-react"
import {
  useAnnotationsStore,
  annotationsForWorkspace,
  type Annotation,
} from "@/stores/annotations-store"

/** Short human label for an annotation's target. */
const anchorLabel = (a: Annotation, intl: IntlShape): string => {
  if (a.anchor.kind === "region") return intl.formatMessage({ id: "editor.annotation.region", defaultMessage: "Region" })
  return a.anchor.name?.trim() || `<${a.anchor.tagName}>`
}

const designCount = (a: Annotation): number =>
  (a.design?.declarations.length ?? 0) + (a.design?.text != null ? 1 : 0)

/**
 * Convert a workspace's annotations into composer message files: a markdown
 * context part (`asText`, merged into the message in `useChatActions`) plus the
 * element screenshot as an image. Used by `ChatPanel` on send.
 */
export type AnnotationFile = FileUIPart & {
  id: string
  content?: string
  asText?: boolean
}

export const annotationToFiles = (a: Annotation): AnnotationFile[] => {
  const comment = a.comment.trim()
  const markdown = comment.length > 0 ? `${a.context}\n\n**Comment:** ${comment}` : a.context
  const files: AnnotationFile[] = [
    {
      id: `${a.id}-ctx`,
      type: "file",
      filename: "annotation.md",
      mediaType: "text/markdown",
      url: `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown)}`,
      content: markdown,
      asText: true,
    },
  ]
  if (a.screenshotDataUrl) {
    files.push({
      id: `${a.id}-img`,
      type: "file",
      filename: "annotation.png",
      mediaType: "image/png",
      url: a.screenshotDataUrl,
    })
  }
  return files
}

/**
 * The chat-side annotation list. Renders the workspace's queued annotations as
 * removable cards just above the composer. Deleting one removes it from the
 * shared store, which re-syncs the on-page pins. They're sent
 * to the agent (and cleared) when the message is sent — see `ChatPanel`.
 */
export function AnnotationTray({ workspaceId }: { workspaceId: number | null }) {
  const intl = useIntl()
  const items = useAnnotationsStore((s) => s.items)
  const remove = useAnnotationsStore((s) => s.remove)
  const mine = useMemo(() => annotationsForWorkspace(items, workspaceId), [items, workspaceId])

  if (mine.length === 0) return null

  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-1.5">
      {mine.map((a, i) => {
        const n = designCount(a)
        return (
          <div
            key={a.id}
            className="group flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted/20 py-1 pl-1.5 pr-1 text-xs"
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-foreground text-[10px] font-medium text-background">
              {i + 1}
            </span>
            {a.screenshotDataUrl ? (
              <img
                src={a.screenshotDataUrl}
                alt=""
                className="h-5 w-5 shrink-0 rounded object-cover"
              />
            ) : null}
            <span className="max-w-[140px] truncate text-foreground">{anchorLabel(a, intl)}</span>
            {n > 0 ? (
              <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
                <SlidersHorizontal className="h-3 w-3" />
                {n}
              </span>
            ) : null}
            {a.comment.trim() ? (
              <span className="max-w-[120px] truncate text-muted-foreground">
                {a.comment.trim()}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => remove(a.id)}
              title={intl.formatMessage({ id: "editor.annotation.remove", defaultMessage: "Remove annotation" })}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
