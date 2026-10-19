import { useState } from "react"
import { CircleArrowUp, Loader2 } from "lucide-react"
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useUpdateStore } from "@/stores/update-store"

/**
 * Sidebar affordance for a downloaded-but-not-installed update.
 *
 * Renders nothing until the updater reports `downloaded`; from then on it sits
 * next to the help button as one more rail icon button — same size, radius and
 * hover as its neighbours. Only the icon carries the brand colour: that is
 * enough to be spotted in a quiet rail without a filled slab that no other
 * control in the app uses. Clicking it opens a dialog that explains the
 * restart. Dismissing the dialog keeps the button around, so the update is
 * never lost and never interrupts.
 */
export function UpdateReadyPill() {
  const intl = useIntl()
  const downloadedVersion = useUpdateStore((state) => state.downloadedVersion)
  const [open, setOpen] = useState(false)
  const [restarting, setRestarting] = useState(false)

  if (!downloadedVersion) return null

  const handleRestart = () => {
    setRestarting(true)
    window.electronAPI?.installUpdate()
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid="update-ready-pill"
            aria-label={intl.formatMessage(
              { id: "update.ready.aria", defaultMessage: "Update v{version} ready to install" },
              { version: downloadedVersion },
            )}
            onClick={() => setOpen(true)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-brand transition-colors hover:bg-accent-hover active:bg-accent-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 animate-in fade-in zoom-in-95 duration-300"
          >
            <CircleArrowUp className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <FormattedMessage
            id="update.ready.tooltip"
            defaultMessage="Update v{version} ready"
            values={{ version: downloadedVersion }}
          />
        </TooltipContent>
      </Tooltip>

      <Dialog open={open} onOpenChange={(next) => !restarting && setOpen(next)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              <FormattedMessage id="update.ready.title" defaultMessage="Update ready to install" />
            </DialogTitle>
            <DialogDescription>
              <FormattedMessage
                id="update.ready.desc"
                defaultMessage="operon v{version} has been downloaded. Restart the app now to finish installing it, or keep working and install it later."
                values={{ version: downloadedVersion }}
              />
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" className="h-8" onClick={() => setOpen(false)} disabled={restarting}>
              <FormattedMessage id="update.ready.later" defaultMessage="Later" />
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="h-8 gap-1.5"
              onClick={handleRestart}
              disabled={restarting}
            >
              {restarting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <FormattedMessage id="update.ready.restart" defaultMessage="Restart & install" />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
