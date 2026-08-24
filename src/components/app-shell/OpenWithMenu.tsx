import { useState } from "react"
import { useIntl } from "react-intl"
import { ChevronDown, ExternalLink, Loader2 } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { useOpenWith } from "./useOpenWith"

interface OpenWithMenuProps {
  /** Absolute path to open (the active workspace root). Null disables the menu. */
  targetPath: string | null
}

/**
 * Top-bar "Open with…" dropdown — lists the editors/terminals installed on the
 * machine (resolved + icon'd by the main process) and opens the active
 * workspace in the chosen one. The trigger shows the *preferred* app's real
 * icon (codex-style): the last app you opened with, or the first available one.
 * macOS / Electron only; renders nothing elsewhere.
 */
export function OpenWithMenu({ targetPath }: OpenWithMenuProps) {
  const intl = useIntl()
  const { available, apps, preferredApp, open: openWith } = useOpenWith()
  const [open, setOpen] = useState(false)

  if (!available) return null

  const openWithLabel = intl.formatMessage({ id: "appShell.openWith", defaultMessage: "Open with…" })

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={openWithLabel}
          title={openWithLabel}
          className={cn(
            "flex h-6 items-center gap-0.5 rounded-md px-1 text-muted-foreground transition-colors",
            "hover:bg-muted/60 hover:text-foreground",
            "data-[state=open]:bg-muted/70 data-[state=open]:text-foreground"
          )}
        >
          {preferredApp?.iconDataUrl != null ? (
            <img src={preferredApp.iconDataUrl} alt="" className="h-4 w-4 shrink-0" />
          ) : (
            <ExternalLink className="h-4 w-4 shrink-0" />
          )}
          <ChevronDown className="h-3 w-3 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52 border-border/40">
        {apps == null ? (
          <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {intl.formatMessage({ id: "appShell.openWithLoading", defaultMessage: "Loading…" })}
          </div>
        ) : apps.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            {intl.formatMessage({ id: "appShell.openWithNoApps", defaultMessage: "No apps found" })}
          </div>
        ) : (
          <>
            {targetPath == null && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground/70">
                {intl.formatMessage({ id: "appShell.openWithSelectWorkspace", defaultMessage: "Select a workspace first" })}
              </div>
            )}
            {apps.map((appItem) => (
              <DropdownMenuItem
                key={appItem.id}
                disabled={targetPath == null}
                onClick={() => void openWith(targetPath, appItem)}
                className="gap-2.5 py-1.5"
              >
              {appItem.iconDataUrl != null ? (
                <img
                  src={appItem.iconDataUrl}
                  alt=""
                  className="h-5 w-5 shrink-0"
                />
              ) : (
                <span className="h-5 w-5 shrink-0 rounded bg-muted" />
              )}
                <span className="text-sm">{appItem.label}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
