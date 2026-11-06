import { memo, useState, type ReactNode } from "react"
import { useTransform } from "motion/react"
import { useIntl } from "react-intl"
import { PanelLeft } from "lucide-react"
import { useAppShellStore } from "@/stores/app-shell-store"
import { ProjectSidebar } from "@/components/project/ProjectSidebar"
import { LeftSidebar } from "./LeftSidebar"
import {
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  LEFT_SIDEBAR_RAIL_WIDTH,
  SIDEBAR_TOGGLE_LEFT,
  TITLEBAR_TOGGLE_CLEARANCE,
} from "./constants"
import { TitlebarClearanceContext } from "./TitlebarRow"
import { usePanelAnimation } from "./use-panel-animation"

/*
 * The sidebar's collapsed flag is read here and in SidebarToggle only, never
 * in App: App re-rendering on a toggle re-rendered every page it hosts (the
 * right panel, the Assistant's activity, the Inbox list…), a long task that
 * swallowed the first ~160ms of the open animation. Titlebars receive a
 * stable MotionValue so their padding follows the sidebar without React renders.
 */

interface AppSidebarProps {
  onOpenSpec: (taskId: number, projectId: number) => void
  children: ReactNode
}

export const AppSidebar = memo(function AppSidebar({ onOpenSpec, children }: AppSidebarProps) {
  const sidebarCollapsed = useAppShellStore((s) => s.sidebarCollapsed)
  const setSidebarCollapsed = useAppShellStore((s) => s.setSidebarCollapsed)
  const [width, setWidth] = useState(LEFT_SIDEBAR_DEFAULT_WIDTH)
  const { progress, collapsed: rail } = usePanelAnimation({
    size: width - LEFT_SIDEBAR_RAIL_WIDTH,
    isVisible: !sidebarCollapsed,
  })
  const animatedWidth = useTransform(progress, (value) =>
    LEFT_SIDEBAR_RAIL_WIDTH + value * (width - LEFT_SIDEBAR_RAIL_WIDTH)
  )
  const titlebarClearance = useTransform(animatedWidth, (value) =>
    Math.max(0, TITLEBAR_TOGGLE_CLEARANCE - value)
  )

  return (
    <TitlebarClearanceContext.Provider value={titlebarClearance}>
      <div className="flex h-full w-full">
        <LeftSidebar
          isOpen={!sidebarCollapsed}
          rail={rail}
          animatedWidth={animatedWidth}
          progress={progress}
          onWidthChange={setWidth}
          onClose={() => setSidebarCollapsed(true)}
        >
          <ProjectSidebar onOpenSpec={onOpenSpec} collapsed={rail} width={width} />
        </LeftSidebar>
        {children}
      </div>
    </TitlebarClearanceContext.Provider>
  )
})

/**
 * Pinned at the window's top-left and mounted once, so it never moves or
 * remounts while the sidebar animates. Render it after every titlebar: native
 * drag hit-testing follows DOM order, so a `drag-region` placed later would
 * cover its `no-drag`.
 */
export function SidebarToggle() {
  const intl = useIntl()
  const sidebarCollapsed = useAppShellStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useAppShellStore((s) => s.toggleSidebar)
  const label = sidebarCollapsed
    ? intl.formatMessage({ id: "app.expandSidebar", defaultMessage: "Expand sidebar" })
    : intl.formatMessage({ id: "sidebar.collapse", defaultMessage: "Collapse sidebar" })

  return (
    <div
      className="no-drag absolute top-0 z-50 flex h-10 w-6 items-center border-b border-transparent"
      style={{ left: SIDEBAR_TOGGLE_LEFT }}
    >
      <button
        type="button"
        data-testid="toggle-sidebar"
        aria-label={label}
        aria-expanded={!sidebarCollapsed}
        title={label}
        onClick={toggleSidebar}
        className="no-drag pointer-events-auto flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <PanelLeft className="size-4 -translate-y-px" />
      </button>
    </div>
  )
}
