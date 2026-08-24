import { useMemo } from "react"
import { useIntl } from "react-intl"
import { MessageSquare, X } from "lucide-react"
import {
  useLineCommentsStore,
  lineCommentsForWorkspace,
  formatCommentLocation,
} from "@/stores/line-comments-store"

/**
 * The chat-side list of queued inline comments. Renders the workspace's line
 * comments (from a diff or file preview) as removable chips just above the
 * composer, mirroring {@link AnnotationTray}. They fold into the next message
 * and clear on send — see `ChatPanel.handleSubmit`.
 */
export function LineCommentTray({ workspaceId }: { workspaceId: number | null }) {
  const intl = useIntl()
  const items = useLineCommentsStore((s) => s.items)
  const remove = useLineCommentsStore((s) => s.remove)
  const mine = useMemo(
    () => lineCommentsForWorkspace(items, workspaceId),
    [items, workspaceId]
  )

  if (mine.length === 0) return null

  const getBasename = (path: string) => path.split(/[/\\]/).pop() || path

  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-1.5">
      {mine.map((comment) => (
        <div
          key={comment.id}
          className="group flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted/20 py-1 pl-1.5 pr-1 text-xs"
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
            <MessageSquare className="h-2.5 w-2.5" />
          </span>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {getBasename(comment.path)}:{formatCommentLocation(comment)}
          </span>
          {comment.text.trim() ? (
            <span className="max-w-[160px] truncate text-foreground">
              {comment.text.trim()}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => remove(comment.id)}
            title={intl.formatMessage({
              id: "editor.lineComment.remove",
              defaultMessage: "Remove comment",
            })}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  )
}
