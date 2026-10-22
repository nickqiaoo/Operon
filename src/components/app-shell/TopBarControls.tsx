import { useIntl } from "react-intl"
import { Activity, PanelBottom, PanelRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { useAppShellStore } from "@/stores/app-shell-store"
import { useSessionPanelStore } from "@/stores/session-panel-store"
import { toggleBottomPanelWithTerminal } from "./tabs/tab-entries"

/** The chat's Session cards toggle stays in the center header. */
export function SessionPanelToggle() {
  const intl = useIntl()
  const sessionAvailable = useSessionPanelStore((s) => s.owner != null)
  const sessionPanelOpen = useSessionPanelStore((s) => s.open)
  const toggleSessionPanel = useSessionPanelStore((s) => s.toggle)

  if (!sessionAvailable) return null

  return (
    <button
      type="button"
      data-testid="toggle-session-panel"
      onClick={toggleSessionPanel}
      className={cn(
        "no-drag mr-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors",
        sessionPanelOpen
          ? "bg-muted/70 text-foreground"
          : "text-muted-foreground hover:bg-row-hover hover:text-foreground"
      )}
      title={intl.formatMessage({ id: "editor.agentPanel.open", defaultMessage: "Session panel" })}
      aria-pressed={sessionPanelOpen}
    >
      <Activity className="h-3.5 w-3.5" />
    </button>
  )
}

/**
 * The window's top-right controls: the bottom/right panel toggles.
 * ("Open with…" lives in the file browser's
 * toolbar, next to the file it opens.)
 *
 * Rendered INLINE inside whichever bar is pinned to the window's top-right
 * (the right panel's tab strip when it's open, else the center header). Those
 * bars are `drag-region`; these controls are `no-drag`, which macOS honors
 * because they're real children of the drag bar — unlike a floating `fixed`
 * overlay, which the OS ignores (clicks fall through to the drag region).
 */
export function TopBarControls() {
  const intl = useIntl()
  const bottomPanelOpen = useAppShellStore((s) => s.bottomPanelOpen)
  const rightPanelOpen = useAppShellStore((s) => s.rightPanelOpen)
  const toggleRightPanel = useAppShellStore((s) => s.toggleRightPanel)

  return (
    <div className="no-drag flex items-center gap-0.5">
      <button
        type="button"
        data-testid="toggle-bottom-panel"
        onClick={toggleBottomPanelWithTerminal}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-md transition-colors",
          bottomPanelOpen
            ? "bg-muted/70 text-foreground"
            : "text-muted-foreground hover:bg-row-hover hover:text-foreground"
        )}
        title={intl.formatMessage({ id: "appShell.toggleBottomPanel", defaultMessage: "Toggle bottom panel (⌘J)" })}
        aria-pressed={bottomPanelOpen}
      >
        <PanelBottom className="h-4 w-4" />
      </button>
      <button
        type="button"
        data-testid="toggle-right-panel"
        onClick={toggleRightPanel}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-md transition-colors",
          rightPanelOpen
            ? "bg-muted/70 text-foreground"
            : "text-muted-foreground hover:bg-row-hover hover:text-foreground"
        )}
        title={intl.formatMessage({ id: "appShell.toggleRightPanel", defaultMessage: "Toggle right panel (⌘\\)" })}
        aria-pressed={rightPanelOpen}
      >
        <PanelRight className="h-4 w-4" />
      </button>
    </div>
  )
}
