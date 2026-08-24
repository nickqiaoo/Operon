import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { useAppShellStore } from "@/stores/app-shell-store"
import { BottomPanel } from "./BottomPanel"
import { CENTER_CONTENT_MIN_WIDTH } from "./constants"
import { RightPanel } from "./RightPanel"
import { PanelTabsProvider } from "./tabs/PanelTabsProvider"
import { useWorkflowTab } from "./useWorkflowTab"
import { WorkflowRunsSync } from "@/components/editor/components/WorkflowRunsSync"

interface AppShellProps {
  /** Main content (chat, editor, etc) — occupies the squeezable center area. */
  children: ReactNode
  className?: string
}

/**
 * App shell layout: main content + right panel as flex siblings, bottom panel
 * below. Wrapped in a single DndContext (PanelTabsProvider) so tab drags can
 * cross between the right and bottom panels.
 *
 * When either side panel is in "expanded" mode, the center content collapses
 * to width/height 0 and the panel takes its space — same DOM, no remount.
 */
export function AppShell({ children, className }: AppShellProps) {
  const rightExpanded = useAppShellStore((s) => s.rightPanelExpanded)
  const rightOpen = useAppShellStore((s) => s.rightPanelOpen)

  // A started workflow raises its own tab here — the shell outlives any single
  // conversation, so the tab survives switching chats while a run is in flight.
  useWorkflowTab()

  const rightTakesCenter = rightOpen && rightExpanded
  const centerStyle =
    rightOpen && !rightTakesCenter
      ? { minWidth: CENTER_CONTENT_MIN_WIDTH }
      : undefined

  return (
    <PanelTabsProvider>
      {/* One global subscription to every workflow run — the shell outlives any
          conversation, and a detached run must keep being watched when you
          switch chats or close the panel. */}
      <WorkflowRunsSync />
      <div
        className={cn(
          "relative flex h-full min-h-0 w-full flex-col bg-background",
          className
        )}
      >
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <div
            className={cn(
              "relative flex min-w-0 flex-col overflow-hidden",
              rightTakesCenter ? "w-0 flex-none" : "flex-1"
            )}
            style={centerStyle}
            aria-hidden={rightTakesCenter}
          >
            {children}
          </div>
          <RightPanel />
        </div>
        <BottomPanel />
      </div>
    </PanelTabsProvider>
  )
}
