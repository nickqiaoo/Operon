import { useCallback, useEffect, useRef } from "react"
import { motion } from "motion/react"
import { Maximize2, Minimize2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { useAppShellStore } from "@/stores/app-shell-store"
import { useTabsStore } from "@/stores/tabs-store"
import { ResizeHandle } from "./ResizeHandle"
import { usePanelAnimation } from "./use-panel-animation"
import {
  CENTER_CONTENT_MIN_WIDTH,
  RIGHT_PANEL_AUTO_CLOSE_BELOW,
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
} from "./constants"
import { TabBar } from "./tabs/TabBar"
import { TabContent } from "./tabs/TabContent"
import { useVisiblePanelTabs } from "./tabs/use-visible-tabs"
import { EmptyPanelState } from "./tabs/EmptyPanelState"
import { TopBarControls } from "./TopBarControls"

interface RightPanelProps {
  className?: string
}

const getMaxWidthWithCenterReserve = (container: HTMLElement | null) => {
  const parent = container?.parentElement
  if (parent == null) return RIGHT_PANEL_MAX_WIDTH

  const parentWidth = parent.getBoundingClientRect().width
  const availableWidth = Math.floor(parentWidth - CENTER_CONTENT_MIN_WIDTH)

  return Math.max(
    RIGHT_PANEL_MIN_WIDTH,
    Math.min(RIGHT_PANEL_MAX_WIDTH, availableWidth)
  )
}

const clampWidthWithCenterReserve = (
  value: number,
  container: HTMLElement | null
) =>
  Math.max(
    RIGHT_PANEL_MIN_WIDTH,
    Math.min(getMaxWidthWithCenterReserve(container), value)
  )

/**
 * Right side panel.
 *
 * Outer motion.aside animates width 0 → target. Inner absolutely-positioned
 * div is pinned to the full target width so content doesn't squish during the
 * animation — the parent's overflow-hidden clips it. This produces the
 * "push open" feel matching Codex.
 *
 * Tabs are read from useTabsStore.right.
 */
export function RightPanel({ className }: RightPanelProps) {
  const containerRef = useRef<HTMLElement | null>(null)
  const isOpen = useAppShellStore((s) => s.rightPanelOpen)
  const width = useAppShellStore((s) => s.rightPanelWidth)
  const setOpen = useAppShellStore((s) => s.setRightPanelOpen)
  const setWidth = useAppShellStore((s) => s.setRightPanelWidth)
  const expanded = useAppShellStore((s) => s.rightPanelExpanded)
  const toggleExpanded = useAppShellStore((s) => s.toggleRightPanelExpanded)
  const sidebarCollapsed = useAppShellStore((s) => s.sidebarCollapsed)
  // Expanded + sidebar collapsed means this strip is the window's top-left
  // corner, so it has to clear the macOS traffic lights the way every other
  // leftmost titlebar row does. Any other combination has the sidebar or the
  // center header sitting there instead, and padding here would just be a gap.
  const reserveTrafficLights =
    __APP_TARGET__ !== "web" && expanded && sidebarCollapsed
  const panel = useTabsStore((s) => s.right)
  // Render from the *visible* list: browser tabs are filtered by the active
  // conversation (see use-visible-tabs.ts).
  // `panel` above still drives "collapse once the last tab closes", which has to
  // read the real count. Using the filtered one there would make the whole panel
  // vanish the moment you switch to a conversation that has no browser tabs.
  const { tabs: visibleTabs, activeTabId: visibleActiveTabId } = useVisiblePanelTabs("right")

  const { isMounted, opacity, animatedSize } = usePanelAnimation({
    size: width,
    isVisible: isOpen,
  })

  // When the user closes the last tab, also collapse the panel itself.
  // Only fires on the > 0 → 0 transition so opening an empty panel stays open.
  const prevTabCountRef = useRef(panel.tabs.length)
  useEffect(() => {
    if (prevTabCountRef.current > 0 && panel.tabs.length === 0 && isOpen) {
      setOpen(false)
    }
    prevTabCountRef.current = panel.tabs.length
  }, [panel.tabs.length, isOpen, setOpen])

  const handleResize = useCallback((next: number) => {
    if (next < RIGHT_PANEL_AUTO_CLOSE_BELOW) {
      setOpen(false)
      return
    }
    setWidth(clampWidthWithCenterReserve(next, containerRef.current))
  }, [setOpen, setWidth])

  useEffect(() => {
    if (!isOpen || expanded) return

    const parent = containerRef.current?.parentElement
    if (parent == null) return

    const clampToAvailableWidth = () => {
      const next = clampWidthWithCenterReserve(width, containerRef.current)
      if (next !== width) setWidth(next)
    }

    clampToAvailableWidth()

    const observer = new ResizeObserver(clampToAvailableWidth)
    observer.observe(parent)
    window.addEventListener("resize", clampToAvailableWidth)

    return () => {
      observer.disconnect()
      window.removeEventListener("resize", clampToAvailableWidth)
    }
  }, [expanded, isOpen, setWidth, width])

  if (!isMounted && !isOpen) return null

  return (
    <motion.aside
      ref={containerRef}
      data-app-shell-focus-area="right-panel"
      className={cn(
        "relative ml-auto h-full min-h-0 min-w-0 overflow-visible",
        expanded ? "w-full flex-1" : "shrink-0",
        className
      )}
      style={
        expanded
          ? { opacity }
          : { opacity, width: animatedSize }
      }
    >
      {!expanded && (
        <ResizeHandle
          edge="left"
          defaultSize={RIGHT_PANEL_DEFAULT_WIDTH}
          getSizeFromPointer={({ x }) => {
            const right =
              containerRef.current?.getBoundingClientRect().right ??
              window.innerWidth
            return right - x
          }}
          setSize={handleResize}
        />
      )}
      <div className="absolute inset-0 min-h-0 min-w-0 overflow-hidden">
        <div
          className="absolute top-0 bottom-0 left-0 flex min-w-0 flex-col border-l border-border/50 bg-background"
          style={
            expanded
              ? { width: "100%", minWidth: 0, right: 0 }
              : { width, minWidth: width }
          }
        >
          {/* Right panel header: + on left, then the window's top-right
              controls (this panel sits at the window's right edge when open).
              The bar's empty space is a drag-region; the buttons are no-drag. */}
          <TabBar
            panelId="right"
            dragRegion
            className={reserveTrafficLights ? "pl-20" : undefined}
            accessory={
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={toggleExpanded}
                  aria-label={expanded ? "Restore right panel" : "Expand right panel"}
                  aria-pressed={expanded}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                >
                  {expanded ? (
                    <Minimize2 className="h-3.5 w-3.5" />
                  ) : (
                    <Maximize2 className="h-3.5 w-3.5" />
                  )}
                </button>
                <TopBarControls />
              </div>
            }
          />
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {visibleTabs.map((tab) => {
              const isActive = tab.tabId === visibleActiveTabId
              return (
                <div
                  key={tab.tabId}
                  className="absolute inset-0 overflow-hidden"
                  style={{
                    opacity: isActive ? 1 : 0,
                    zIndex: isActive ? 1 : 0,
                    pointerEvents: isActive ? "auto" : "none",
                  }}
                  aria-hidden={!isActive}
                >
                  <TabContent panelId="right" tab={tab} isActive={isActive} />
                </div>
              )
            })}
            {visibleTabs.length === 0 && <EmptyPanelState panelId="right" />}
          </div>
        </div>
      </div>
    </motion.aside>
  )
}
