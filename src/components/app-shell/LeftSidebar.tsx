import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react"
import { motion, useMotionValueEvent, useTransform } from "motion/react"
import { cn } from "@/lib/utils"
import { ResizeHandle } from "./ResizeHandle"
import { usePanelAnimation } from "./use-panel-animation"
import {
  LEFT_SIDEBAR_AUTO_CLOSE_BELOW,
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  LEFT_SIDEBAR_RAIL_WIDTH,
  LEFT_SIDEBAR_MAX_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
  TITLEBAR_TOGGLE_CLEARANCE,
} from "./constants"

interface LeftSidebarProps {
  /**
   * `rail` turns true only once the close animation has finished, and false as
   * soon as it reopens: in between the expanded layout is clipped by the
   * moving edge, the same way in both directions.
   */
  children: (rail: boolean) => ReactNode
  /** Whether the sidebar should currently be open. */
  isOpen: boolean
  /** Target width in px when open. */
  width: number
  onWidthChange: (width: number) => void
  /** Called when a resize drag shrinks the sidebar past the auto-close size. */
  onClose: () => void
  className?: string
}

const clampWidth = (value: number) =>
  Math.max(LEFT_SIDEBAR_MIN_WIDTH, Math.min(LEFT_SIDEBAR_MAX_WIDTH, value))

// Labels are gone well before the edge reaches them, and come in once the
// sidebar is mostly open, so no half-clipped text lingers in the slow tail.
const labelOpacity = (progress: number) =>
  Math.max(0, Math.min(1, (progress - 0.25) / 0.75))

/** Keeps the navigation rail visible while the project sidebar is collapsed. */
export function LeftSidebar({
  children,
  isOpen,
  width,
  onWidthChange,
  onClose,
  className,
}: LeftSidebarProps) {
  const containerRef = useRef<HTMLElement | null>(null)
  const { progress, collapsed: rail } = usePanelAnimation({
    size: width - LEFT_SIDEBAR_RAIL_WIDTH,
    isVisible: isOpen,
  })

  const animatedWidth = useTransform(progress, (value) =>
    LEFT_SIDEBAR_RAIL_WIDTH + value * (width - LEFT_SIDEBAR_RAIL_WIDTH)
  )

  // Written straight to the DOM per frame (no React render), and only when the
  // value changes: a custom property restyles the whole subtree below it.
  // The parent row holds the titlebars beside the sidebar (`titlebar-inset`);
  // the labels inside read the opacity (`sidebar-label-fade`).
  const written = useRef({ clear: Number.NaN, opacity: Number.NaN })
  const writeShellVars = useCallback(() => {
    const aside = containerRef.current
    const host = aside?.parentElement
    if (!aside || !host) return
    const clear = Math.max(0, TITLEBAR_TOGGLE_CLEARANCE - animatedWidth.get())
    if (clear !== written.current.clear) {
      written.current.clear = clear
      host.style.setProperty("--titlebar-toggle-clear", `${clear}px`)
    }
    const opacity = labelOpacity(progress.get())
    if (opacity !== written.current.opacity) {
      written.current.opacity = opacity
      aside.style.setProperty("--sidebar-label-opacity", String(opacity))
    }
  }, [animatedWidth, progress])
  useMotionValueEvent(animatedWidth, "change", writeShellVars)
  useLayoutEffect(writeShellVars)

  const handleResize = useCallback(
    (next: number) => {
      if (next < LEFT_SIDEBAR_AUTO_CLOSE_BELOW) {
        onClose()
        return
      }
      onWidthChange(clampWidth(next))
    },
    [onClose, onWidthChange]
  )

  return (
    <motion.aside
      ref={containerRef}
      aria-label="Main navigation"
      data-testid="left-sidebar"
      className={cn(
        "relative h-full min-h-0 min-w-0 shrink-0 overflow-visible",
        className
      )}
      style={{ width: animatedWidth }}
    >
      <div
        className={cn(
          "absolute inset-y-0 left-0 flex w-full min-w-0 flex-col bg-sidebar",
          // The edge line is drawn over the content rather than taking a pixel
          // from it, so the content gets the full 52px rail (square 32px pills).
          // Below the titlebar it is always there; through the titlebar
          // (before:) only while expanded, fading with the labels, so the
          // rail doesn't cut the titlebar band into a cross.
          "after:pointer-events-none after:absolute after:top-10 after:bottom-0 after:right-0 after:w-px after:bg-border/50",
          "before:pointer-events-none before:absolute before:top-0 before:right-0 before:z-10 before:h-10 before:w-px before:bg-border/50 before:opacity-[var(--sidebar-label-opacity,1)]",
          // The rail's project preview floats out past the edge.
          !rail && "overflow-hidden"
        )}
      >
        {children(rail)}
      </div>
      {isOpen && (
        <ResizeHandle
          edge="right"
          defaultSize={LEFT_SIDEBAR_DEFAULT_WIDTH}
          getSizeFromPointer={({ x }) => {
            const left = containerRef.current?.getBoundingClientRect().left ?? 0
            return x - left
          }}
          setSize={handleResize}
        />
      )}
    </motion.aside>
  )
}
