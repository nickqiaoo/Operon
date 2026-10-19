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
import { TOOLBAR_PILL, TOOLBAR_PILL_BUTTON } from "@/components/ui/toolbar-styles"
import { useOpenWith } from "./useOpenWith"

interface OpenWithMenuProps {
  /** Absolute path to open — the previewed file, else the workspace root. */
  targetPath: string | null
}

/**
 * The file browser's "Open ▾" capsule (codex-style). The main half opens
 * `targetPath` in the *preferred* app — the last one you opened with, or the
 * first available — shown by its real icon; the chevron lists the
 * editors/terminals installed on the machine (resolved + icon'd by the main
 * process). macOS / Electron only; renders nothing elsewhere.
 */
export function OpenWithMenu({ targetPath }: OpenWithMenuProps) {
  const intl = useIntl()
  const { available, apps, preferredApp, open: openWith } = useOpenWith()
  const [open, setOpen] = useState(false)

  if (!available) return null

  const openWithLabel = intl.formatMessage({ id: "appShell.openWith", defaultMessage: "Open with…" })
  const openInLabel =
    preferredApp != null
      ? intl.formatMessage(
          { id: "appShell.openIn", defaultMessage: "Open in {app}" },
          { app: preferredApp.label }
        )
      : openWithLabel

  return (
    <div className={TOOLBAR_PILL}>
      <button
        type="button"
        disabled={targetPath == null || preferredApp == null}
        onClick={() => void openWith(targetPath)}
        aria-label={openInLabel}
        title={openInLabel}
        className={cn(TOOLBAR_PILL_BUTTON, "gap-1.5 pl-3 pr-2 text-foreground")}
      >
        {preferredApp?.iconDataUrl != null ? (
          <img src={preferredApp.iconDataUrl} alt="" className="h-4 w-4 shrink-0" />
        ) : (
          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="@max-[560px]:hidden">
          {intl.formatMessage({ id: "appShell.open", defaultMessage: "Open" })}
        </span>
      </button>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={openWithLabel}
            title={openWithLabel}
            className={cn(TOOLBAR_PILL_BUTTON, "w-7 pr-0.5 data-[state=open]:bg-accent-active data-[state=open]:text-foreground")}
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent onCloseAutoFocus={(e) => e.preventDefault()} align="end" className="w-52 border-border/40">
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
            apps.map((appItem) => (
              <DropdownMenuItem
                key={appItem.id}
                disabled={targetPath == null}
                onClick={() => void openWith(targetPath, appItem)}
                className="gap-2.5 py-1.5"
              >
                {appItem.iconDataUrl != null ? (
                  <img src={appItem.iconDataUrl} alt="" className="h-5 w-5 shrink-0" />
                ) : (
                  <span className="h-5 w-5 shrink-0 rounded bg-muted" />
                )}
                <span className="text-sm">{appItem.label}</span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
