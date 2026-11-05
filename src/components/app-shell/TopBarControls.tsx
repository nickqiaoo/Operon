import { useIntl } from "react-intl"
import { Activity, Maximize2, Minimize2, PanelBottom, PanelRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { useAppShellStore } from "@/stores/app-shell-store"
import { useSessionPanelStore } from "@/stores/session-panel-store"
import { toggleBottomPanelWithTerminal } from "./tabs/tab-entries"

/**
 * The chat's Session cards toggle stays in the center header. The caller spaces
 * it: 2px when the panel toggles follow it, as they sit 2px from each other.
 */
export function SessionPanelToggle({ className }: { className?: string }) {
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
        "no-drag flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors",
        className,
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
 * Mounted once in App's fixed titlebar layer, after the draggable headers.
 * Panel animations never move, fade or remount these controls.
 */
export function TopBarControls() {
  const intl = useIntl()
  const bottomPanelOpen = useAppShellStore((s) => s.bottomPanelOpen)
  const rightPanelOpen = useAppShellStore((s) => s.rightPanelOpen)
  const rightPanelExpanded = useAppShellStore((s) => s.rightPanelExpanded)
  const toggleRightPanel = useAppShellStore((s) => s.toggleRightPanel)
  const toggleRightPanelExpanded = useAppShellStore((s) => s.toggleRightPanelExpanded)

  return (
    <div className="no-drag flex items-center gap-0.5">
      {rightPanelOpen && (
        <button
          type="button"
          onClick={toggleRightPanelExpanded}
          aria-label={rightPanelExpanded
            ? intl.formatMessage({ id: "appShell.restoreRightPanel", defaultMessage: "Restore right panel" })
            : intl.formatMessage({ id: "appShell.expandRightPanel", defaultMessage: "Expand right panel" })}
          aria-pressed={rightPanelExpanded}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent-hover hover:text-foreground"
        >
          {rightPanelExpanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </button>
      )}
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
