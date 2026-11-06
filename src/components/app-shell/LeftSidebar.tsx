import { useCallback, type ReactNode } from "react"
import { motion, useTransform, type MotionValue } from "motion/react"
import { cn } from "@/lib/utils"
import { ResizeHandle } from "./ResizeHandle"
import {
  LEFT_SIDEBAR_AUTO_CLOSE_BELOW,
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  LEFT_SIDEBAR_MAX_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
} from "./constants"

interface LeftSidebarProps {
  children: ReactNode
  /** Whether the sidebar should currently be open. */
  isOpen: boolean
  /** Switch to the icon rail once the close animation finishes. */
  rail: boolean
  animatedWidth: MotionValue<number>
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

/** Keeps the navigation rail visible while the project sidebar is collapsed. */
export function LeftSidebar({
  children,
  isOpen,
  rail,
  animatedWidth,
  progress,
  onWidthChange,
  onClose,
  className,
}: LeftSidebarProps) {
  const animatedLabelOpacity = useTransform(progress, labelOpacity)
  const style = {
    width: animatedWidth,
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
        {children}
      </div>
      {isOpen && (
        <ResizeHandle
          edge="right"
          defaultSize={LEFT_SIDEBAR_DEFAULT_WIDTH}
          // The sidebar is docked at the viewport's left edge.
          getSizeFromPointer={({ x }) => x}
          setSize={handleResize}
        />
      )}
    </motion.aside>
  )
}
