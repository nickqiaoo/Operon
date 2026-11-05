import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { motion } from "motion/react"
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

interface RightPanelProps {
  className?: string
}

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
  const preferredWidth = useAppShellStore((s) => s.rightPanelWidth)
  // The room the center leaves, measured on every parent resize. The ref is
  // always current (resize drags clamp to it); the state only changes when it
  // changes the rendered width, so a resize that leaves the panel within its
  // preferred width (each frame of the left sidebar's animation) re-renders
  // nothing.
  const maxWidthRef = useRef(RIGHT_PANEL_MAX_WIDTH)
  const preferredWidthRef = useRef(preferredWidth)
  preferredWidthRef.current = preferredWidth
  const [maxWidth, setMaxWidth] = useState(RIGHT_PANEL_MAX_WIDTH)
  // A skipped update may have left the state behind the ref; a new preferred
  // width (a resize drag) has to clamp against the real room.
  useLayoutEffect(() => setMaxWidth(maxWidthRef.current), [preferredWidth])
  const width = Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(maxWidth, preferredWidth))
  const setOpen = useAppShellStore((s) => s.setRightPanelOpen)
  const setWidth = useAppShellStore((s) => s.setRightPanelWidth)
  const expanded = useAppShellStore((s) => s.rightPanelExpanded)
  const panel = useTabsStore((s) => s.right)

  const { hasOpened, collapsed, opacity, animatedSize } = usePanelAnimation({
    size: width,
    isVisible: isOpen,
  })

  // When the user closes the last tab, also collapse the panel itself.
  // Only fires on the > 0 → 0 transition so opening an empty panel stays open.
  const workspaceId = useTabsStore((state) => state.currentWorkspaceId)
  const previousPanel = useRef({ workspaceId, count: panel.tabs.length })
  useEffect(() => {
    if (previousPanel.current.workspaceId === workspaceId && previousPanel.current.count > 0 && panel.tabs.length === 0 && isOpen) {
      setOpen(false)
    }
    previousPanel.current = { workspaceId, count: panel.tabs.length }
  }, [workspaceId, panel.tabs.length, isOpen, setOpen])

  const handleResize = useCallback((next: number) => {
    if (next < RIGHT_PANEL_AUTO_CLOSE_BELOW) {
      setOpen(false)
      return
    }
    setWidth(Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(maxWidthRef.current, next)))
  }, [setOpen, setWidth])

  useEffect(() => {
    if (!isOpen || expanded) return

    const parent = containerRef.current?.parentElement
    if (parent == null) return

    const measureAvailableWidth = () => {
      const parentWidth = parent.getBoundingClientRect().width
      // Assistant / Inbox / Board hide the mounted editor with display:none.
      // A hidden layout has no usable measurement, not a new preferred width.
      if (parentWidth <= 0) return
      const next = Math.max(
        RIGHT_PANEL_MIN_WIDTH,
        Math.min(RIGHT_PANEL_MAX_WIDTH, Math.floor(parentWidth - CENTER_CONTENT_MIN_WIDTH))
      )
      maxWidthRef.current = next
      const preferred = preferredWidthRef.current
      setMaxWidth((previous) =>
        Math.min(previous, preferred) === Math.min(next, preferred) ? previous : next
      )
    }

    measureAvailableWidth()

    // Commit inside the observer callback, before paint. A plain setState lands a
    // frame late, so while the left sidebar animates open the panel is still the
    // old width every frame and its right edge pokes past the window, then snaps back.
    const observer = new ResizeObserver(() => flushSync(measureAvailableWidth))
    observer.observe(parent)
    window.addEventListener("resize", measureAvailableWidth)

    return () => {
      observer.disconnect()
      window.removeEventListener("resize", measureAvailableWidth)
    }
  }, [expanded, isOpen])

  if (!hasOpened) return null

  return (
    <motion.aside
      ref={containerRef}
      data-app-shell-focus-area="right-panel"
      // Kept mounted while closed: inert drops focus out of it and blocks the
      // resize handle; visibility skips painting the zero-width content.
      inert={collapsed}
      aria-hidden={collapsed}
      className={cn(
        "relative ml-auto h-full min-h-0 min-w-0 overflow-visible",
        expanded ? "w-full flex-1" : "shrink-0",
        collapsed && "invisible",
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
          <RightPanelBody expanded={expanded} collapsed={collapsed} />
        </div>
      </div>
    </motion.aside>
  )
}

/**
 * The tab strip and tab contents. Memoized apart from the shell: the shell
 * re-renders on every width change (a resize drag, each frame of the left
 * sidebar's animation while the panel is clamped), and none of that reaches
 * the tabs.
 */
const RightPanelBody = memo(function RightPanelBody({ expanded, collapsed }: { expanded: boolean; collapsed: boolean }) {
  // Render from the *visible* list: browser tabs are filtered by the active
  // conversation (see use-visible-tabs.ts). RightPanel's `panel` still drives
  // "collapse once the last tab closes", which has to read the real count:
  // the filtered one would make the whole panel vanish the moment you switch
  // to a conversation that has no browser tabs.
  const { tabs: visibleTabs, activeTabId: visibleActiveTabId } = useVisiblePanelTabs("right")

  return (
    <>
      {/* pr: room for App's fixed panel controls at the window's top-right.
          Expanded, the strip also starts at the sidebar's edge. */}
      <TabBar
        panelId="right"
        dragRegion
        titlebarInset={expanded}
        className="pr-[84px]"
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
              {/* Browser / terminal overlays hide on !isActive, which is
                  what unmounting used to do for them on close. */}
              <TabContent panelId="right" tab={tab} isActive={isActive && !collapsed} />
            </div>
          )
        })}
        {visibleTabs.length === 0 && <EmptyPanelState panelId="right" />}
      </div>
    </>
  )
})
