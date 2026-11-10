import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { createPortal } from "react-dom"

/** How long the pointer has to rest on the text before the full version appears. */
const HOVER_DELAY_MS = 500
/** Below this distance from the top of the window the tooltip opens under the text. */
const MIN_SPACE_ABOVE_PX = 48
const OFFSET_PX = 4
const VIEWPORT_PADDING_PX = 8

interface TruncatedTextProps {
  children: string
  /** Must include `truncate`. */
  className?: string
}

/**
 * Text that shows its full version in a tooltip on hover, only when it is
 * actually cut off.
 *
 * Deliberately not built on `ui/tooltip`: these sit in model lists with hundreds
 * of rows, and one Radix Tooltip per row tripled the time to open the list
 * (165ms to 530ms for 325 models in a dev build).
 */
export function TruncatedText({ children, className }: TruncatedTextProps) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const showAfterDelay = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.pointerType !== "mouse") return
    const element = event.currentTarget
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      if (element.scrollWidth > element.clientWidth) setAnchor(element.getBoundingClientRect())
    }, HOVER_DELAY_MS)
  }
  const hide = () => {
    window.clearTimeout(timer.current)
    setAnchor(null)
  }

  return (
    <span className={className} onPointerEnter={showAfterDelay} onPointerLeave={hide} onPointerDown={hide}>
      {children}
      {anchor &&
        createPortal(
          <div
            role="tooltip"
            data-slot="tooltip-content"
            className="pointer-events-none fixed z-50 rounded-lg bg-foreground px-3 py-1.5 text-xs break-all text-background animate-in fade-in-0 zoom-in-95"
            style={{
              left: anchor.left,
              maxWidth: `min(24rem, calc(100vw - ${anchor.left + VIEWPORT_PADDING_PX}px))`,
              ...(anchor.top > MIN_SPACE_ABOVE_PX
                ? { bottom: window.innerHeight - anchor.top + OFFSET_PX }
                : { top: anchor.bottom + OFFSET_PX }),
            }}
          >
            {children}
          </div>,
          document.body,
        )}
    </span>
  )
}
