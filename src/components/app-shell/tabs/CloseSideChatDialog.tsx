import { useState } from "react"
import { FormattedMessage, useIntl } from "react-intl"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface CloseSideChatDialogProps {
  open: boolean
  /** Confirmed close. `skipNextTime` reflects the "don't ask again" checkbox. */
  onConfirm: (skipNextTime: boolean) => void
  onCancel: () => void
}

/**
 * Guards closing a side chat that has been used.
 *
 * A side chat is deliberately throwaway — closing it deletes the conversation
 * and its forked session with no undo and nothing that lists it afterwards — so
 * a click on × is the whole of the decision. Only shown once the user has
 * actually said something; closing one they opened and never used needs no
 * ceremony.
 */
export function CloseSideChatDialog({ open, onConfirm, onCancel }: CloseSideChatDialogProps) {
  const intl = useIntl()
  const [skipNextTime, setSkipNextTime] = useState(false)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setSkipNextTime(false)
          onCancel()
        }
      }}
    >
      <DialogContent className="sm:max-w-100">
        <DialogHeader>
          <DialogTitle>
            <FormattedMessage
              id="sideChat.closeConfirm.title"
              defaultMessage="Close side chat?"
            />
          </DialogTitle>
          <DialogDescription>
            <FormattedMessage
              id="sideChat.closeConfirm.description"
              defaultMessage="This side chat will be gone and can’t be recovered."
            />
          </DialogDescription>
        </DialogHeader>

        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={skipNextTime}
            onChange={(event) => setSkipNextTime(event.target.checked)}
            className="h-3.5 w-3.5 rounded border-border/50"
          />
          <FormattedMessage
            id="sideChat.closeConfirm.dontAskAgain"
            defaultMessage="Don’t ask again"
          />
        </label>

        <DialogFooter>
          <Button size="sm" variant="ghost" className="h-8" onClick={onCancel}>
            <FormattedMessage id="sideChat.closeConfirm.cancel" defaultMessage="Cancel" />
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="h-8 text-destructive hover:text-destructive"
            autoFocus
            onClick={() => {
              onConfirm(skipNextTime)
              setSkipNextTime(false)
            }}
            aria-label={intl.formatMessage({
              id: "sideChat.closeConfirm.confirm",
              defaultMessage: "Close side chat",
            })}
          >
            <FormattedMessage
              id="sideChat.closeConfirm.confirm"
              defaultMessage="Close side chat"
            />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
