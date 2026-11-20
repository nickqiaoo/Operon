import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { useTransform } from "motion/react"
import { useIntl } from "react-intl"
import { PanelLeft } from "lucide-react"
import { sidebarPanelShown, useAppShellStore, useSidebarPanelShown } from "@/stores/app-shell-store"
import { useNavigationStore } from "@/stores/navigation-store"
import { ProjectSidebar } from "@/components/project/ProjectSidebar"
import type { Notification } from "@/types/notification"
import type { OpenChat } from "@/lib/active-conversations"
import { LeftSidebar } from "./LeftSidebar"
import {
  CENTER_CONTENT_MIN_WIDTH,
  LEFT_SIDEBAR_CENTER_RESERVE,
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
  LEFT_SIDEBAR_RAIL_WIDTH,
  RIGHT_PANEL_AUTO_CLOSE_BELOW,
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
  onOpenNotification: (notification: Notification) => void
  onOpenChat: OpenChat
  children: ReactNode
}

export const AppSidebar = memo(function AppSidebar({ onOpenSpec, onOpenNotification, onOpenChat, children }: AppSidebarProps) {
  // The panel is out only on the workspace views (or when the toggle asked for
  // it elsewhere); everywhere else the rail is all there is.
  const panelShown = useSidebarPanelShown()
  const setSidebarCollapsed = useAppShellStore((s) => s.setSidebarCollapsed)
  const [width, setWidth] = useState(LEFT_SIDEBAR_DEFAULT_WIDTH)
  const previousWindowWidth = useRef(Infinity)
  // `width` is the panel's; the rail is always there on top of it.
  const maxWidth = __APP_TARGET__ === "electron"
    ? `max(${LEFT_SIDEBAR_RAIL_WIDTH + LEFT_SIDEBAR_MIN_WIDTH}px, calc(100vw - ${LEFT_SIDEBAR_CENTER_RESERVE}px))`
    : undefined
  const panelMaxWidth = __APP_TARGET__ === "electron"
    ? `max(${LEFT_SIDEBAR_MIN_WIDTH}px, calc(100vw - ${LEFT_SIDEBAR_CENTER_RESERVE + LEFT_SIDEBAR_RAIL_WIDTH}px))`
    : undefined

  useLayoutEffect(() => {
    if (__APP_TARGET__ !== "electron") return

    const handleWindowResize = () => {
      const windowWidth = window.innerWidth
      const shrinking = windowWidth < previousWindowWidth.current
      previousWindowWidth.current = windowWidth
      if (!shrinking) return

      const shell = useAppShellStore.getState()
      const shown = sidebarPanelShown(shell, useNavigationStore.getState().main)
      const sidebarWidth = LEFT_SIDEBAR_RAIL_WIDTH + (shown ? width : 0)
      const splitMinWidth = sidebarWidth + CENTER_CONTENT_MIN_WIDTH + RIGHT_PANEL_AUTO_CLOSE_BELOW
      if (shell.rightPanelOpen && !shell.rightPanelExpanded && windowWidth < splitMinWidth) {
        shell.setRightPanelOpen(false)
      }
      if (shown && windowWidth < LEFT_SIDEBAR_RAIL_WIDTH + LEFT_SIDEBAR_MIN_WIDTH + LEFT_SIDEBAR_CENTER_RESERVE) {
        shell.setSidebarCollapsed(true)
      }
    }

    handleWindowResize()
    window.addEventListener("resize", handleWindowResize)
    return () => window.removeEventListener("resize", handleWindowResize)
  }, [width])

  const { progress, collapsed: rail } = usePanelAnimation({
    size: width,
    isVisible: panelShown,
  })
  const animatedWidth = useTransform(progress, (value) =>
    LEFT_SIDEBAR_RAIL_WIDTH + value * width
  )
  const titlebarClearance = useTransform(animatedWidth, (value) =>
    Math.max(0, TITLEBAR_TOGGLE_CLEARANCE - value)
  )

  return (
    <TitlebarClearanceContext.Provider value={titlebarClearance}>
      {/* With only the rail left it is canvas-coloured with no edge line, so a
          page's own left gutter reads as extra rail: the icons sat 16px from
          the window edge but 32px from the board. Pages that run edge to edge
          take their left padding from this (0 here; 1rem fallback elsewhere).
          Keyed to where the panel is going, not to the end of its animation:
          switched at the end, the Board slid left with the closing panel and
          then jumped another 16px. Not eased either: a custom property on this
          root restyles the whole app on every frame (~7ms). */}
      <div className="flex h-full w-full" style={panelShown ? undefined : { "--rail-page-gutter": "0px" } as CSSProperties}>
        <LeftSidebar
          isOpen={panelShown}
          rail={rail}
          animatedWidth={animatedWidth}
          maxWidth={maxWidth}
          progress={progress}
          onWidthChange={setWidth}
          onClose={() => setSidebarCollapsed(true)}
        >
          <ProjectSidebar onOpenSpec={onOpenSpec} onOpenNotification={onOpenNotification} onOpenChat={onOpenChat}
            collapsed={rail} width={width} maxWidth={panelMaxWidth} />
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
  const panelShown = useSidebarPanelShown()
  const toggleSidebar = useAppShellStore((s) => s.toggleSidebar)
  const label = !panelShown
    ? intl.formatMessage({ id: "app.expandSidebar", defaultMessage: "Expand sidebar" })
    : intl.formatMessage({ id: "sidebar.collapse", defaultMessage: "Collapse sidebar" })

  return (
    <div
      className="no-drag absolute top-0 z-50 flex h-10 w-6 items-center"
      style={{ left: SIDEBAR_TOGGLE_LEFT }}
    >
      <button
        type="button"
        data-testid="toggle-sidebar"
        aria-label={label}
        aria-expanded={panelShown}
        title={label}
        onClick={toggleSidebar}
        className="no-drag pointer-events-auto flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <PanelLeft className="size-4 -translate-y-px" />
      </button>
    </div>
  )
}
