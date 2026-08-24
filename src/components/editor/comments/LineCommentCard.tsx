import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react"
import { FormattedMessage, useIntl } from "react-intl"
import { MessageSquare, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type LineCommentCardProps = {
  /** Human line label, e.g. "R16" or "R16-R18". */
  location: string
  /** Existing note text. Empty means a newly-created line comment. */
  initialText: string
  /** Open directly in edit mode, used for newly-created empty comments. */
  startEditing?: boolean
  /** Persist the note. Called with the trimmed text. */
  onSubmit: (text: string) => void
  /** Revert to the saved text, or remove a newly-created empty comment. */
  onCancel: () => void
  /** Remove the comment. */
  onDelete?: () => void
  className?: string
}

/**
 * The card injected below a commented line (pierre's `renderAnnotation` slot).
 * A newly-created comment opens straight into the editor with Save/Delete.
 * Existing comments show read-only with Edit/Delete. Pointer/keys are kept inside
 * so the underlying diff line interactions don't swallow them.
 */
export function LineCommentCard({
  location,
  initialText,
  startEditing = false,
  onSubmit,
  onCancel,
  onDelete,
  className,
}: LineCommentCardProps) {
  const intl = useIntl()
  const [editing, setEditing] = useState(startEditing)
  const [text, setText] = useState(initialText)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setText(initialText)
  }, [initialText])

  useEffect(() => {
    if (startEditing) setEditing(true)
  }, [startEditing])

  useEffect(() => {
    if (editing) textareaRef.current?.focus()
  }, [editing])

  const submit = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSubmit(trimmed)
    setEditing(false)
  }, [text, onSubmit])

  const cancel = useCallback(() => {
    setText(initialText)
    setEditing(false)
    onCancel()
  }, [initialText, onCancel])

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      cancel()
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
    }
  }

  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation()

  return (
    <div
      className={cn(
        "w-full max-w-2xl min-w-0 rounded-lg border border-border/50 bg-popover/95 p-2.5 font-sans shadow-card",
        className
      )}
      onPointerDown={stop}
      onClick={stop}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/40 bg-muted/40 text-muted-foreground">
          <MessageSquare className="h-3 w-3" />
        </span>
        <span className="text-xs font-medium text-foreground">
          <FormattedMessage id="editor.lineComment.author" defaultMessage="Local comment" />
        </span>
        <span className="ml-auto text-[11px] leading-4 text-muted-foreground">
          <FormattedMessage
            id="editor.lineComment.location"
            defaultMessage="Comment on line {location}"
            values={{ location }}
          />
        </span>
      </div>

      {editing ? (
        <>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={intl.formatMessage({
              id: "editor.lineComment.placeholder",
              defaultMessage: "Request change",
            })}
            rows={2}
            className="min-h-[52px] w-full resize-none rounded-lg border border-border/50 bg-transparent px-3 py-2 text-sm outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-tint/40 focus-visible:ring-1 focus-visible:ring-tint/10"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            {onDelete ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs text-destructive hover:text-destructive"
                onClick={onDelete}
              >
                <Trash2 className="h-3.5 w-3.5" />
                <FormattedMessage id="editor.lineComment.delete" defaultMessage="Delete" />
              </Button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" className="h-7 px-2.5 text-xs" onClick={cancel}>
                <FormattedMessage id="editor.lineComment.cancel" defaultMessage="Cancel" />
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="h-7 px-2.5 text-xs"
                disabled={!text.trim()}
                onClick={submit}
              >
                <FormattedMessage id="editor.lineComment.save" defaultMessage="Save" />
              </Button>
            </div>
          </div>
        </>
      ) : (
        <>
          <p className="whitespace-pre-wrap break-words text-sm text-foreground">{text}</p>
          <div className="mt-2 flex items-center justify-end gap-2">
            {onDelete ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs text-destructive hover:text-destructive"
                onClick={onDelete}
              >
                <Trash2 className="h-3.5 w-3.5" />
                <FormattedMessage id="editor.lineComment.delete" defaultMessage="Delete" />
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => setEditing(true)}
            >
              <FormattedMessage id="editor.lineComment.edit" defaultMessage="Edit" />
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
