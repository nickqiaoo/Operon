import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { animate, motion, useMotionValue, useTransform, type PanInfo } from "motion/react"
import { cn } from "@/lib/utils"

/** How far a resting sheet stands in from the screen's edges. */
const GAP = 8
/**
 * Corner radius: concentric with the phone's own screen corners (≈55pt) at
 * `GAP` in. A card-sized 12px corner sat under the screen's curve and got
 * clipped by it.
 */
const RADIUS = 46
/** The most of the screen a resting sheet takes; the rest is a swipe up away. */
const RESTING_SHARE = 0.55
/** Close to UIKit's sheet: quick, no bounce to speak of. */
const SPRING = { type: "spring", stiffness: 380, damping: 38, mass: 0.9 } as const


/** env() insets as numbers, read off a probe: motion values need pixels. */
function useSafeArea(): { top: number; bottom: number } {
  const [insets, setInsets] = useState({ top: 0, bottom: 0 })
  useLayoutEffect(() => {
    const probe = document.createElement("div")
    probe.style.cssText =
      "position:fixed;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)"
    document.body.appendChild(probe)
    const style = getComputedStyle(probe)
    setInsets({ top: parseFloat(style.paddingTop) || 0, bottom: parseFloat(style.paddingBottom) || 0 })
    probe.remove()
  }, [])
  return insets
}

/**
 * A card that rises from the bottom, as tall as what it holds (up to about
 * half the screen), standing a little in from the edges. Swiped up it opens to
 * full height and meets the screen's sides and bottom; swiped down it goes back
 * to rest, and from rest it closes. Muse's activity sheet, which UIKit gives
 * native apps for free.
 *
 * The child marks its scroll area with `data-sheet-scroll`. At rest that area
 * doesn't scroll (a drag anywhere moves the sheet); opened up it scrolls, and
 * the rest of the sheet is what drags.
 */
export function DetentSheet({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const safe = useSafeArea()
  const [viewport, setViewport] = useState(() => window.innerHeight)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = () => {
      setViewport(window.innerHeight)
      setViewportWidth(window.innerWidth)
    }
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  const contentRef = useRef<HTMLDivElement>(null)
  const [natural, setNatural] = useState<number | null>(null)
  const [expanded, setExpanded] = useState(false)
  const expandedRef = useRef(false)
  expandedRef.current = expanded

  const openHeight = viewport - safe.top - 8
  // Its content's own height, plus the room it leaves the home indicator and its border.
  const fitted = natural === null ? viewport * RESTING_SHARE : natural + Math.max(0, safe.bottom - GAP) + 2
  const restHeight = Math.min(fitted, viewport * RESTING_SHARE, openHeight)

  const height = useMotionValue(restHeight)
  const y = useMotionValue(viewport)
  // 0 at rest, 1 opened up: the edge gap and the bottom corners go with it.
  const bounds = useRef({ rest: restHeight, open: openHeight })
  bounds.current = { rest: restHeight, open: openHeight }
  const progress = useTransform(height, (h) => {
    const { rest, open } = bounds.current
    return open > rest ? Math.min(1, Math.max(0, (h - rest) / (open - rest))) : 0
  })
  const inset = useTransform(progress, (p) => GAP * (1 - p))
  const bottomRadius = useTransform(progress, (p) => RADIUS * (1 - p))
  const paddingBottom = useTransform(inset, (i) => Math.max(0, safe.bottom - i))

  // Rises in on mount.
  useEffect(() => {
    void animate(y, 0, SPRING)
  }, [y])

  // What the content would take: every block at its height, the scroll area unrolled.
  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    const measure = () => {
      let total = 0
      for (const child of Array.from(el.children) as HTMLElement[]) {
        if (!child.hasAttribute("data-sheet-scroll")) {
          total += child.offsetHeight
          continue
        }
        // The scroll area grows to fill the sheet, so its own height says nothing;
        // what it holds does.
        const style = getComputedStyle(child)
        total += parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
        for (const inner of Array.from(child.children) as HTMLElement[]) total += inner.offsetHeight
      }
      // Runs on every frame of a swipe (the sheet's height is changing); only a
      // real change in the content may re-render.
      setNatural((prev) => (prev === total ? prev : total))
    }
    measure()
    const resize = new ResizeObserver(measure)
    resize.observe(el)
    const mutation = new MutationObserver(measure)
    mutation.observe(el, { childList: true, subtree: true, characterData: true })
    return () => {
      resize.disconnect()
      mutation.disconnect()
    }
  }, [])

  // The sheet follows its content (steps arriving on a running task) and the
  // screen. Not on `expanded`: a swipe animates that change itself.
  useEffect(() => {
    height.set(expandedRef.current ? openHeight : restHeight)
  }, [restHeight, openHeight, height])

  const ignorePan = useRef(false)
  const onPanStart = (event: PointerEvent) => {
    // Opened up, the scroll area scrolls; a drag there is not the sheet's.
    const target = event.target as Element | null
    ignorePan.current = expanded && Boolean(target?.closest("[data-sheet-scroll]"))
  }
  const onPan = (_: PointerEvent, info: PanInfo) => {
    if (ignorePan.current) return
    const dy = info.offset.y
    const base = expanded ? openHeight : restHeight
    if (dy < 0) {
      const wanted = base - dy
      // Past full height it resists, as a rubber band.
      height.set(wanted > openHeight ? openHeight + (wanted - openHeight) * 0.15 : wanted)
      y.set(0)
    } else if (expanded) {
      const shrunk = base - dy
      height.set(Math.max(restHeight, shrunk))
      y.set(Math.max(0, restHeight - shrunk))
    } else {
      y.set(dy)
    }
  }
  const onPanEnd = (_: PointerEvent, info: PanInfo) => {
    if (ignorePan.current) return
    const dy = info.offset.y
    const vy = info.velocity.y
    let next: "open" | "rest" | "close"
    if (expanded) {
      next = y.get() > 120 || (y.get() > 0 && vy > 900) ? "close" : dy > 60 || vy > 500 ? "rest" : "open"
    } else {
      next = dy < -40 || vy < -400 ? "open" : dy > 100 || vy > 600 ? "close" : "rest"
    }
    if (next === "close") {
      onClose()
      return
    }
    setExpanded(next === "open")
    void animate(height, next === "open" ? openHeight : restHeight, SPRING)
    void animate(y, 0, SPRING)
  }

  return (
    <motion.div
      className={cn(
        // No shadow: the scrim already sets it apart, and a blurred shadow is
        // repainted on every frame the sheet changes size.
        "fixed z-50 flex touch-none flex-col overflow-hidden border border-border/60 bg-popover dark:border-border/35",
        // At rest the content stays put, so a drag anywhere moves the sheet.
        // touch-none has to sit on the scroll area itself: touch-action stops
        // inheriting at a scroll container, and without it iOS takes the touch
        // for a native pan and the sheet stops following the finger.
        expanded
          ? "[&_[data-sheet-scroll]]:touch-pan-y [&_[data-sheet-scroll]]:overscroll-contain"
          : "[&_[data-sheet-scroll]]:touch-none [&_[data-sheet-scroll]]:overflow-hidden",
      )}
      style={{
        left: inset,
        right: inset,
        bottom: inset,
        // The keyboard pushes it up; a worker's sheet has a box to type in.
        marginBottom: "var(--keyboard-height, 0px)",
        height,
        y,
        paddingBottom,
        borderTopLeftRadius: RADIUS,
        borderTopRightRadius: RADIUS,
        borderBottomLeftRadius: bottomRadius,
        borderBottomRightRadius: bottomRadius,
      }}
      exit={{ y: viewport, transition: SPRING }}
      onPanStart={onPanStart}
      onPan={onPan}
      onPanEnd={onPanEnd}
    >
      {/* A fixed width: as the sheet widens to the screen's edges the text inside
          doesn't rewrap, so a swipe only changes heights, not the whole layout. */}
      <div ref={contentRef} className="flex min-h-0 flex-1 flex-col self-center" style={{ width: viewportWidth - 2 * GAP - 2 }}>
        {children}
      </div>
    </motion.div>
  )
}
