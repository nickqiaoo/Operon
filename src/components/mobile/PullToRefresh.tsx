import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type UIEvent } from "react"
import { Loader2 } from "lucide-react"
import { useIntl } from "react-intl"
import { cn } from "@/lib/utils"

/** Pull distance (after damping) that arms a refresh on release. */
const THRESHOLD = 64
/** Where the indicator parks while the refresh runs. */
const HOLD = 52
/** The furthest the content follows the finger. */
const MAX_PULL = 110
/** Keep the spinner up at least this long, so a fast response doesn't read as a flicker. */
const MIN_SPIN_MS = 450

interface PullToRefreshProps {
  onRefresh: () => Promise<unknown>
  children: ReactNode
  /** Classes for the scrolling element (padding etc.); the wrapper takes the flex slot. */
  className?: string
  style?: CSSProperties
  onScroll?: (e: UIEvent<HTMLDivElement>) => void
  /** Distance from the top of the wrapper to where the indicator appears (below any floating header). */
  indicatorTop?: string
}

/**
 * A scroll container with pull-to-refresh, for the phone lists.
 *
 * The gesture is ours rather than the WebView's rubber band: the scroller sets
 * `overscroll-behavior-y: none` so iOS doesn't bounce it, and a drag that
 * starts at the top moves the content down with damping. Releasing past
 * {@link THRESHOLD} runs `onRefresh` and holds the spinner until it settles.
 */
export function PullToRefresh({ onRefresh, children, className, style, onScroll, indicatorTop = "0px" }: PullToRefreshProps) {
  const intl = useIntl()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [pull, setPull] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const refreshingRef = useRef(false)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    let startX = 0
    let startY: number | null = null
    let pulling = false
    let distance = 0

    const reset = () => {
      startY = null
      pulling = false
      setDragging(false)
    }

    const onStart = (e: TouchEvent) => {
      if (refreshingRef.current || e.touches.length !== 1 || el.scrollTop > 0) {
        startY = null
        return
      }
      startX = e.touches[0].clientX
      startY = e.touches[0].clientY
      pulling = false
      distance = 0
    }

    const onMove = (e: TouchEvent) => {
      if (startY == null) return
      const dx = e.touches[0].clientX - startX
      const dy = e.touches[0].clientY - startY
      if (!pulling) {
        // Wait for a clear downward drag from the very top; anything else is a
        // normal scroll or a horizontal swipe and is left alone.
        if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return
        if (dy <= 0 || Math.abs(dx) > dy || el.scrollTop > 0) {
          startY = null
          return
        }
        pulling = true
        setDragging(true)
      }
      if (e.cancelable) e.preventDefault()
      // Rubber-band damping: easy at first, stiffer the further it goes.
      distance = Math.max(0, Math.min(MAX_PULL, dy * 0.5))
      setPull(distance)
    }

    const onEnd = () => {
      if (!pulling) {
        startY = null
        return
      }
      const armed = distance >= THRESHOLD
      reset()
      if (!armed) {
        setPull(0)
        return
      }
      refreshingRef.current = true
      setRefreshing(true)
      setPull(HOLD)
      const started = Date.now()
      void Promise.resolve()
        .then(() => onRefreshRef.current())
        .catch(() => {})
        .then(() => new Promise((resolve) => setTimeout(resolve, Math.max(0, MIN_SPIN_MS - (Date.now() - started)))))
        .then(() => {
          refreshingRef.current = false
          setRefreshing(false)
          setPull(0)
        })
    }

    el.addEventListener("touchstart", onStart, { passive: true })
    // Not passive: once the pull owns the gesture it has to stop the page scrolling.
    el.addEventListener("touchmove", onMove, { passive: false })
    el.addEventListener("touchend", onEnd)
    el.addEventListener("touchcancel", onEnd)
    return () => {
      el.removeEventListener("touchstart", onStart)
      el.removeEventListener("touchmove", onMove)
      el.removeEventListener("touchend", onEnd)
      el.removeEventListener("touchcancel", onEnd)
    }
  }, [])

  const progress = Math.min(1, pull / THRESHOLD)
  const settle = dragging ? undefined : "transform 300ms cubic-bezier(0.32,0.72,0,1)"

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        aria-hidden={!refreshing}
        role={refreshing ? "status" : undefined}
        aria-label={refreshing ? intl.formatMessage({ id: "mobile.pullToRefresh.refreshing", defaultMessage: "Refreshing…" }) : undefined}
        className="pointer-events-none absolute inset-x-0 z-10 flex justify-center"
        style={{
          top: indicatorTop,
          transform: `translateY(${pull - 40}px)`,
          opacity: refreshing ? 1 : progress,
          transition: dragging ? undefined : `${settle}, opacity 200ms`,
        }}
      >
        <div className="grid size-8 place-items-center rounded-full border border-border/60 bg-popover text-muted-foreground shadow-card dark:border-border/35">
          <Loader2
            className={cn("size-4", refreshing && "animate-spin", !refreshing && progress >= 1 && "text-foreground")}
            style={refreshing ? undefined : { transform: `rotate(${progress * 300}deg)` }}
          />
        </div>
      </div>
      <div
        ref={scrollerRef}
        className={cn("min-h-0 flex-1 overflow-y-auto overscroll-y-none", className)}
        style={style}
        onScroll={onScroll}
      >
        <div
          className="flex min-h-full flex-col"
          style={{ transform: pull > 0 ? `translateY(${pull}px)` : undefined, transition: settle }}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
