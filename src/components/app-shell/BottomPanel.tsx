import { useEffect, useRef } from "react"
import { useIntl } from "react-intl"
import { motion } from "motion/react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useAppShellStore } from "@/stores/app-shell-store"
import { useTabsStore } from "@/stores/tabs-store"
import { ResizeHandle } from "./ResizeHandle"
import { usePanelAnimation } from "./use-panel-animation"
import {
  BOTTOM_PANEL_AUTO_CLOSE_BELOW,
  BOTTOM_PANEL_DEFAULT_HEIGHT,
  BOTTOM_PANEL_MAX_HEIGHT,
  BOTTOM_PANEL_MIN_HEIGHT,
} from "./constants"
import { TabBar } from "./tabs/TabBar"
import { TabContent } from "./tabs/TabContent"
import { useVisiblePanelTabs } from "./tabs/use-visible-tabs"
import { EmptyPanelState } from "./tabs/EmptyPanelState"

interface BottomPanelProps {
  className?: string
}

const clampHeight = (value: number) =>
  Math.max(BOTTOM_PANEL_MIN_HEIGHT, Math.min(BOTTOM_PANEL_MAX_HEIGHT, value))

/**
 * Bottom panel — same architecture as RightPanel but animates height. Inner
 * div is pinned to the full target height; outer's overflow-hidden clips.
 */
export function BottomPanel({ className }: BottomPanelProps) {
  const intl = useIntl()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const isOpen = useAppShellStore((s) => s.bottomPanelOpen)
  const height = useAppShellStore((s) => s.bottomPanelHeight)
  const setOpen = useAppShellStore((s) => s.setBottomPanelOpen)
  const setHeight = useAppShellStore((s) => s.setBottomPanelHeight)
  const panel = useTabsStore((s) => s.bottom)
  // Render from the *visible* list: browser tabs are filtered by the active
  // conversation (see use-visible-tabs.ts).
  // `panel` above still drives "collapse once the last tab closes", which has to
  // read the real count. Using the filtered one there would make the whole panel
  // vanish the moment you switch to a conversation that has no browser tabs.
  const { tabs: visibleTabs, activeTabId: visibleActiveTabId } = useVisiblePanelTabs("bottom")

  const { isMounted, opacity, animatedSize } = usePanelAnimation({
    size: height,
    isVisible: isOpen,
  })

  // Auto-close when the last tab is removed; see RightPanel for the rationale.
  const prevTabCountRef = useRef(panel.tabs.length)
  useEffect(() => {
    if (prevTabCountRef.current > 0 && panel.tabs.length === 0 && isOpen) {
      setOpen(false)
    }
    prevTabCountRef.current = panel.tabs.length
  }, [panel.tabs.length, isOpen, setOpen])

  if (!isMounted && !isOpen) return null

  const handleResize = (next: number) => {
    if (next < BOTTOM_PANEL_AUTO_CLOSE_BELOW) {
      setOpen(false)
      return
    }
    setHeight(clampHeight(next))
  }

  return (
    <motion.div
      ref={containerRef}
      data-app-shell-focus-area="bottom-panel"
      className={cn(
        "relative z-30 min-h-0 w-full shrink-0 overflow-visible",
        className
      )}
      style={{ opacity, height: animatedSize }}
    >
      <ResizeHandle
        edge="top"
        defaultSize={BOTTOM_PANEL_DEFAULT_HEIGHT}
        getSizeFromPointer={({ y }) => {
          const bottom =
            containerRef.current?.getBoundingClientRect().bottom ??
            window.innerHeight
          return bottom - y
        }}
        setSize={handleResize}
      />
      <div className="absolute inset-0 min-h-0 overflow-hidden">
        <div
          className="absolute inset-x-0 top-0 flex min-h-0 flex-col border-t border-border/50 bg-background"
          style={{ height, minHeight: height }}
        >
          <TabBar
            panelId="bottom"
            accessory={
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={intl.formatMessage({ id: "appShell.closeBottomPanel", defaultMessage: "Close bottom panel" })}
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
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
                  <TabContent panelId="bottom" tab={tab} isActive={isActive} />
                </div>
              )
            })}
            {visibleTabs.length === 0 && <EmptyPanelState panelId="bottom" />}
          </div>
        </div>
      </div>
    </motion.div>
  )
}
