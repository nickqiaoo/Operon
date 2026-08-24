import { RefreshCw, X } from "lucide-react"

import { Button } from "@/components/ui/button"

interface PwaUpdatePromptProps {
  updateAvailable: boolean
  onRefresh: () => void
  onDismiss: () => void
}

export function PwaUpdatePrompt({
  updateAvailable,
  onRefresh,
  onDismiss,
}: PwaUpdatePromptProps) {
  if (!updateAvailable) return null

  return (
    <div
      className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+4rem)] z-[80] mx-auto max-w-sm sm:right-auto sm:left-4 sm:bottom-4"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="flex items-center gap-3 rounded-xl border border-border/50 bg-popover/95 px-4 py-3 shadow-float backdrop-blur-md">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            Update available
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Refresh to load the latest version.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-8 gap-1.5"
          onClick={onRefresh}
        >
          <RefreshCw className="size-3.5" />
          Refresh
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <X className="size-4 text-muted-foreground" />
        </Button>
      </div>
    </div>
  )
}
