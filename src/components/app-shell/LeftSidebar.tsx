import { useCallback, type ReactNode } from "react"
import { motion, useTransform, type MotionValue } from "motion/react"
import { cn } from "@/lib/utils"
import { ResizeHandle } from "./ResizeHandle"
import {
  LEFT_SIDEBAR_AUTO_CLOSE_BELOW,
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  LEFT_SIDEBAR_MAX_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
  LEFT_SIDEBAR_RAIL_WIDTH,
} from "./constants"

interface LeftSidebarProps {
  children: ReactNode
  /** Whether the sidebar should currently be open. */
  isOpen: boolean
  /** The panel beside the rail has finished closing (only the rail is left). */
  rail: boolean
  animatedWidth: MotionValue<number>
  maxWidth?: string
  progress: MotionValue<number>
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

/** The icon rail plus the collapsible panel beside it; `animatedWidth` covers both. */
export function LeftSidebar({
  children,
  isOpen,
  rail,
  animatedWidth,
  maxWidth,
  progress,
  onWidthChange,
  onClose,
  className,
}: LeftSidebarProps) {
  const animatedLabelOpacity = useTransform(progress, labelOpacity)
  const style = {
    width: animatedWidth,
    maxWidth,
    "--sidebar-label-opacity": animatedLabelOpacity,
  }

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
      aria-label="Main navigation"
      data-testid="left-sidebar"
      className={cn(
        "relative h-full min-h-0 min-w-0 shrink-0 overflow-visible",
        className
      )}
      style={style}
    >
      <div
        className={cn(
          "absolute inset-y-0 left-0 flex w-full min-w-0 flex-col sidebar-surface-fade",
          // The edge line is drawn over the content rather than taking a pixel
          // from it, so the content gets the full 52px rail (square 32px pills).
          // It fades with the labels: the collapsed rail is canvas-coloured
          // (ProjectSidebar's sidebar-surface-fade) and sits on the canvas
          // with no line, like Codex.
          "after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:z-10 after:w-px after:bg-border/50 after:opacity-[var(--sidebar-label-opacity,1)]",
          // The rail's project preview floats out past the edge.
          !rail && "overflow-hidden"
        )}
      >
        {children}
      </div>
      {isOpen && (
        <ResizeHandle
          edge="right"
          defaultSize={LEFT_SIDEBAR_DEFAULT_WIDTH}
          // Docked at the viewport's left edge; the size is the panel's,
          // right of the fixed rail.
          getSizeFromPointer={({ x }) => x - LEFT_SIDEBAR_RAIL_WIDTH}
          setSize={handleResize}
        />
      )}
    </motion.aside>
  )
}
