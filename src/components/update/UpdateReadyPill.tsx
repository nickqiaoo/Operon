import { useState } from "react"
import { ArrowUp, Loader2 } from "lucide-react"
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
 * quietly next to the help button as a small brand-purple pill. Clicking it
 * opens a dialog that explains the restart. Dismissing the dialog keeps the
 * pill around, so the update is never lost and never interrupts.
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
            className="flex h-7 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-brand-fg transition-colors hover:bg-brand-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 animate-in fade-in zoom-in-95 duration-300"
          >
            <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.75} />
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
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-muted text-brand">
                <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
              </div>
              <div className="min-w-0 space-y-1.5 text-left">
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
              </div>
            </div>
          </DialogHeader>
          <DialogFooter className="border-t border-border/40 pt-4">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={restarting}>
              <FormattedMessage id="update.ready.later" defaultMessage="Later" />
            </Button>
            <Button
              className="bg-brand text-brand-fg hover:bg-brand-soft active:bg-brand-soft"
              onClick={handleRestart}
              disabled={restarting}
            >
              {restarting && <Loader2 className="h-4 w-4 animate-spin" />}
              <FormattedMessage id="update.ready.restart" defaultMessage="Restart & install" />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
