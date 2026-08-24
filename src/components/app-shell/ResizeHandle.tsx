import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

type Edge = "left" | "right" | "top" | "bottom"

interface ResizeHandleProps {
  /** Which edge of the panel this handle sits on. Determines axis + cursor. */
  edge: Edge
  /** Size to reset to on double-click (px). */
  defaultSize: number
  /** Project pointer position to a panel size value. */
  getSizeFromPointer: (point: { x: number; y: number }) => number
  /** Called continuously while dragging with the projected size. */
  setSize: (size: number) => void
  /** Optional notification so the parent can suspend transitions while dragging. */
  onResizingChange?: (resizing: boolean) => void
}

interface DragState {
  startPosition: number
  didMove: boolean
}

/**
 * Pointer-driven resize handle for a side panel edge.
 *
 * - Single-click does nothing.
 * - Drag continuously calls setSize with the projected pointer position.
 * - Double-click resets the panel to defaultSize.
 *
 * Mirrors Codex's resize handle (file-tree-search bundle): a thin strip with
 * a centered gradient line that brightens on hover/active.
 */
export function ResizeHandle({
  edge,
  defaultSize,
  getSizeFromPointer,
  setSize,
  onResizingChange,
}: ResizeHandleProps) {
  const [isResizing, setIsResizing] = useState(false)
  const dragStateRef = useRef<DragState | null>(null)
  const isVertical = edge === "left" || edge === "right"

  useEffect(() => {
    if (!isResizing) return

    const stop = () => {
      dragStateRef.current = null
      setIsResizing(false)
      onResizingChange?.(false)
    }

    const handleMove = (event: PointerEvent) => {
      event.preventDefault()
      const point = { x: event.clientX, y: event.clientY }
      const projected = isVertical ? point.x : point.y
      const drag = dragStateRef.current
      if (drag != null && projected !== drag.startPosition) {
        drag.didMove = true
      }
      setSize(getSizeFromPointer(point))
    }

    const handleUp = (event: PointerEvent) => {
      event.preventDefault()
      if (dragStateRef.current?.didMove === true) {
        setSize(getSizeFromPointer({ x: event.clientX, y: event.clientY }))
      }
      stop()
    }

    window.addEventListener("pointermove", handleMove)
    window.addEventListener("pointerup", handleUp)
    window.addEventListener("pointercancel", handleUp)
    return () => {
      window.removeEventListener("pointermove", handleMove)
      window.removeEventListener("pointerup", handleUp)
      window.removeEventListener("pointercancel", handleUp)
    }
  }, [isResizing, isVertical, getSizeFromPointer, setSize, onResizingChange])

  const handleClick = (event: React.MouseEvent) => {
    if (event.detail === 2) {
      event.preventDefault()
      dragStateRef.current = null
      setIsResizing(false)
      onResizingChange?.(false)
      setSize(defaultSize)
    }
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const startPosition = isVertical ? event.clientX : event.clientY
    dragStateRef.current = { didMove: false, startPosition }
    setIsResizing(true)
    onResizingChange?.(true)
  }

  // Position the strip so it overlaps the panel edge by a couple of pixels —
  // gives a comfortable grab target without taking up layout space.
  const positionClass = {
    left: "top-0 bottom-0 left-0 w-2 -translate-x-1 cursor-col-resize",
    right: "top-0 bottom-0 right-0 w-2 translate-x-1 cursor-col-resize",
    top: "left-0 right-0 top-0 h-2 -translate-y-1 cursor-row-resize",
    bottom: "left-0 right-0 bottom-0 h-2 translate-y-1 cursor-row-resize",
  }[edge]

  const zClass = edge === "left" ? "z-40" : "z-20"

  const lineClass = isVertical
    ? "h-full w-px bg-gradient-to-b from-transparent via-foreground/25 to-transparent"
    : "h-px w-full bg-gradient-to-r from-transparent via-foreground/25 to-transparent"

  return (
    <div
      role="separator"
      aria-orientation={isVertical ? "vertical" : "horizontal"}
      className={cn(
        "group absolute flex touch-none select-none",
        positionClass,
        zClass
      )}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
    >
      <div
        className={cn(
          "pointer-events-none m-auto opacity-0 transition-opacity",
          lineClass,
          isResizing
            ? "opacity-100"
            : "group-hover:opacity-100 group-active:opacity-100"
        )}
      />
    </div>
  )
}
