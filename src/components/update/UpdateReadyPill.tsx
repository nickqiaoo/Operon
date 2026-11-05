import { useEffect, useState } from "react"
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
import { cn } from "@/lib/utils"
import { useUpdateStore } from "@/stores/update-store"

/**
 * Sidebar affordance for a downloaded-but-not-installed update.
 *
 * Renders nothing until the updater reports `downloaded`; from then on it is
 * one more icon button among its neighbours, in their size, radius and hover:
 * `row` beside the help button in the expanded sidebar, `rail` a rail slot of
 * the collapsed one. Only the icon carries the brand colour: that is enough to
 * be spotted in a quiet rail without a filled slab that no other control in
 * the app uses. Clicking it opens a dialog that explains the restart.
 * Dismissing the dialog keeps the button around, so the update is never lost
 * and never interrupts.
 */
interface UpdateReadyPillProps {
  variant?: "row" | "rail"
  className?: string
}

// The pop-in announces the update once per launch. Both variants mount and
// unmount as the sidebar changes mode; replaying it there would flash.
let introPlayed = false

export function UpdateReadyPill({ variant = "row", className }: UpdateReadyPillProps) {
  const intl = useIntl()
  const downloadedVersion = useUpdateStore((state) => state.downloadedVersion)
  const [open, setOpen] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [intro] = useState(() => !introPlayed)
  useEffect(() => {
    if (downloadedVersion) introPlayed = true
  }, [downloadedVersion])

  if (!downloadedVersion) return null

  const handleRestart = () => {
    setRestarting(true)
    window.electronAPI?.installUpdate()
  }

  return (
    <>
      <Tooltip delayDuration={600}>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid="update-ready-pill"
            aria-label={intl.formatMessage(
              { id: "update.ready.aria", defaultMessage: "Update v{version} ready to install" },
              { version: downloadedVersion },
            )}
            onClick={() => setOpen(true)}
            className={cn(
              "flex shrink-0 items-center text-brand transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              variant === "rail"
                // Same slot as the rail's nav items (see ProjectSidebar).
                ? "h-10 w-full rounded-xl border-4 border-transparent bg-clip-padding px-1.5 hover:bg-row-hover"
                : "size-9 justify-center rounded-lg hover:bg-accent-hover active:bg-accent-active",
              intro && "animate-in fade-in zoom-in-95 duration-300",
              className,
            )}
          >
            <CircleArrowUp className={variant === "rail" ? "size-5" : "size-4"} />
          </button>
        </TooltipTrigger>
        <TooltipContent side={variant === "rail" ? "right" : "top"}>
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
