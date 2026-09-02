import { useMemo } from "react"
import { useIntl } from "react-intl"
import { PanelBottom, PanelRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { useAppShellStore } from "@/stores/app-shell-store"
import { useProjectStore } from "@/stores/project-store"
import { OpenWithMenu } from "./OpenWithMenu"
import { toggleBottomPanelWithTerminal } from "./tabs/tab-entries"

/**
 * The window's top-right controls: "Open with…" + bottom/right panel toggles.
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

  const activeWorkspaceId = useProjectStore((s) => s.activeWorkspaceId)
  const projects = useProjectStore((s) => s.projects)
  const targetPath = useMemo(() => {
    for (const project of projects) {
      const workspace = project.workspaces.find((w) => w.id === activeWorkspaceId)
      if (workspace != null) return workspace.worktreePath
    }
    return null
  }, [projects, activeWorkspaceId])

  return (
    <div className="no-drag flex items-center gap-0.5">
      <OpenWithMenu targetPath={targetPath} />
      <div className="mx-0.5 h-4 w-px bg-border/50" />
      <button
        type="button"
        data-testid="toggle-bottom-panel"
        onClick={toggleBottomPanelWithTerminal}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-md transition-colors",
          bottomPanelOpen
            ? "bg-muted/70 text-foreground"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
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
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        )}
        title={intl.formatMessage({ id: "appShell.toggleRightPanel", defaultMessage: "Toggle right panel (⌘\\)" })}
        aria-pressed={rightPanelOpen}
      >
        <PanelRight className="h-4 w-4" />
      </button>
    </div>
  )
}
