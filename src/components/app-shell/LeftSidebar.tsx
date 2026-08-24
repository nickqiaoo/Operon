import { useCallback, useRef, type ReactNode } from "react"
import { motion } from "motion/react"
import { cn } from "@/lib/utils"
import { ResizeHandle } from "./ResizeHandle"
import { usePanelAnimation } from "./use-panel-animation"
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
  /** Target width in px when open. */
  width: number
  onWidthChange: (width: number) => void
  /** Called when a resize drag shrinks the sidebar past the auto-close size. */
  onClose: () => void
  className?: string
}

const clampWidth = (value: number) =>
  Math.max(LEFT_SIDEBAR_MIN_WIDTH, Math.min(LEFT_SIDEBAR_MAX_WIDTH, value))

/**
 * Left project sidebar — same "push open" mechanics as {@link RightPanel} but
 * mirrored to the left edge. The outer motion.aside animates width 0 → target;
 * the inner div is pinned to the full target width (anchored left) so its
 * content doesn't squish during the animation — the parent's overflow-hidden
 * clips it, producing the slide-in/out push the right panel uses.
 */
export function LeftSidebar({
  children,
  isOpen,
  width,
  onWidthChange,
  onClose,
  className,
}: LeftSidebarProps) {
  const containerRef = useRef<HTMLElement | null>(null)
  const { isMounted, opacity, animatedSize } = usePanelAnimation({
    size: width,
    isVisible: isOpen,
  })

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

  if (!isMounted && !isOpen) return null

  return (
    <motion.aside
      ref={containerRef}
      className={cn(
        "relative h-full min-h-0 min-w-0 shrink-0 overflow-visible",
        className
      )}
      style={{ opacity, width: animatedSize }}
    >
      <div className="absolute inset-0 min-h-0 min-w-0 overflow-hidden">
        <div
          className="absolute top-0 bottom-0 left-0 flex min-w-0 flex-col border-r border-border/50 bg-sidebar"
          style={{ width, minWidth: width }}
        >
          {children}
        </div>
      </div>
      <ResizeHandle
        edge="right"
        defaultSize={LEFT_SIDEBAR_DEFAULT_WIDTH}
        getSizeFromPointer={({ x }) => {
          const left = containerRef.current?.getBoundingClientRect().left ?? 0
          return x - left
        }}
        setSize={handleResize}
      />
    </motion.aside>
  )
}
