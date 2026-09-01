import { useMemo } from "react"
import { useIntl } from "react-intl"
import { Quote, X } from "lucide-react"
import {
  useSelectedTextStore,
  selectedTextForChat,
} from "@/stores/selected-text-store"

/**
 * Queued file-preview selections, as removable chips above the composer.
 *
 * Mirrors {@link LineCommentTray} on purpose: both are "something picked on
 * another surface, waiting to ride along with the next message", and they stack
 * in the same strip. They fold into the next message and clear on send — see
 * `ChatPanel.handleSubmit`.
 */
export function SelectedTextTray({
  workspaceId,
  chatId,
}: {
  workspaceId: number | null
  chatId: number | undefined
}) {
  const intl = useIntl()
  const items = useSelectedTextStore((s) => s.items)
  const remove = useSelectedTextStore((s) => s.remove)
  const mine = useMemo(
    () => selectedTextForChat(items, workspaceId, chatId),
    [items, workspaceId, chatId]
  )

  if (mine.length === 0) return null

  const getBasename = (path: string) => path.split(/[/\\]/).pop() || path

  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-1.5">
      {mine.map((snippet) => (
        <div
          key={snippet.id}
          className="group flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted/20 py-1 pl-1.5 pr-1 text-xs"
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
            <Quote className="h-2.5 w-2.5" />
          </span>
          {snippet.path != null && (
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {getBasename(snippet.path)}
              {snippet.location != null ? `:${snippet.location}` : ""}
            </span>
          )}
          <span className="max-w-[160px] truncate text-foreground">
            {snippet.text.trim().replace(/\s+/g, " ")}
          </span>
          <button
            type="button"
            onClick={() => remove(snippet.id)}
            title={intl.formatMessage({
              id: "editor.selectedText.remove",
              defaultMessage: "Remove selection",
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
