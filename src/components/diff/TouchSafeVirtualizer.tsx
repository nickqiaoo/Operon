import { useCallback, useState, type CSSProperties, type ReactNode } from "react"
import { Virtualizer as CoreVirtualizer, type VirtualizerConfig } from "@pierre/diffs"
import { VirtualizerContext } from "@pierre/diffs/react"

/**
 * Drop-in replacement for `@pierre/diffs/react`'s `<Virtualizer>` that does not
 * fight iOS / iPadOS touch scrolling.
 *
 * Why: after every render pass Pierre runs `scrollFix()`, which keeps the line
 * under the viewport anchored by calling `root.scrollTo()` whenever measured
 * heights differ from the placeholder estimates (wrapped lines, a patch diff
 * swapped for the full-file diff, sub-pixel rounding on 2x screens…). With a
 * mouse wheel that is invisible, but WebKit on iOS treats a programmatic
 * scrollTop write during a finger drag / momentum fling as a competing scroll,
 * so the list visibly shakes.
 *
 * Fix (same idea as react-virtuoso's iOS "deviation"): while a touch gesture or
 * its momentum is active, accumulate the correction as a `translateY` on the
 * content layer — visually identical, and Pierre's next anchor measurement
 * (getBoundingClientRect) already includes it. Once scrolling settles, drop the
 * transform and apply the summed offset to scrollTop in the same frame.
 * Without touch input (desktop, trackpad) Pierre's original path runs as-is.
 */

const SETTLE_DELAY_MS = 150

interface ScrollFixInternals {
  applyScrollFix: (scrollOffset: number) => void
}

interface TouchSafeVirtualizerProps {
  children: ReactNode
  config?: Partial<VirtualizerConfig>
  className?: string
  style?: CSSProperties
  contentClassName?: string
  contentStyle?: CSSProperties
}

interface TouchController {
  instance: CoreVirtualizer
  attach: (root: HTMLElement) => void
  detach: () => void
}

function createTouchController(config?: Partial<VirtualizerConfig>): TouchController {
  const instance = new CoreVirtualizer(config)
  // `applyScrollFix` is private in Pierre's typings but a plain instance
  // property at runtime; this is the single place we hook into it.
  const internals = instance as unknown as ScrollFixInternals
  const originalApplyScrollFix = internals.applyScrollFix.bind(instance)

  let root: HTMLElement | null = null
  let content: HTMLElement | null = null
  let touching = false
  let gestureActive = false
  let deviation = 0
  let settleTimer: ReturnType<typeof setTimeout> | null = null

  const clearSettle = () => {
    if (settleTimer != null) clearTimeout(settleTimer)
    settleTimer = null
  }

  const flush = () => {
    clearSettle()
    gestureActive = false
    if (deviation === 0 || root == null) return
    const offset = deviation
    deviation = 0
    if (content != null) content.style.transform = ""
    instance.markDOMDirty()
    // Same frame as removing the transform, so nothing moves on screen.
    instance.scrollTo({ top: root.scrollTop + offset, behavior: "instant" })
  }

  const scheduleSettle = () => {
    clearSettle()
    settleTimer = setTimeout(() => {
      settleTimer = null
      if (!touching) flush()
    }, SETTLE_DELAY_MS)
  }

  internals.applyScrollFix = (scrollOffset: number) => {
    if (!gestureActive || content == null) {
      originalApplyScrollFix(scrollOffset)
      return
    }
    // Sub-pixel corrections come from rounding on 2x screens, not from real
    // layout shifts; applying them only adds shake.
    if (Math.abs(scrollOffset) < 0.5) return
    deviation += scrollOffset
    content.style.transform = `translate3d(0, ${-deviation}px, 0)`
    instance.markDOMDirty()
  }

  const onTouchStart = () => {
    touching = true
    gestureActive = true
    clearSettle()
  }
  const onTouchEnd = () => {
    touching = false
    // Momentum keeps scrolling after the finger lifts; `onScroll` pushes the
    // settle point out until it stops.
    scheduleSettle()
  }
  const onScroll = () => {
    if (gestureActive && !touching) scheduleSettle()
  }

  return {
    instance,
    attach(node) {
      root = node
      content = node.firstElementChild instanceof HTMLElement ? node.firstElementChild : null
      node.addEventListener("touchstart", onTouchStart, { passive: true })
      node.addEventListener("touchend", onTouchEnd, { passive: true })
      node.addEventListener("touchcancel", onTouchEnd, { passive: true })
      node.addEventListener("scroll", onScroll, { passive: true })
    },
    detach() {
      clearSettle()
      if (root != null) {
        root.removeEventListener("touchstart", onTouchStart)
        root.removeEventListener("touchend", onTouchEnd)
        root.removeEventListener("touchcancel", onTouchEnd)
        root.removeEventListener("scroll", onScroll)
      }
      if (content != null) content.style.transform = ""
      root = null
      content = null
      touching = false
      gestureActive = false
      deviation = 0
    },
  }
}

export function TouchSafeVirtualizer({
  children,
  config,
  className,
  style,
  contentClassName,
  contentStyle,
}: TouchSafeVirtualizerProps) {
  const [controller] = useState(() =>
    typeof window !== "undefined" ? createTouchController(config) : undefined,
  )
  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      if (controller == null) return
      if (node != null) {
        controller.instance.setup(node)
        controller.attach(node)
      } else {
        controller.detach()
        controller.instance.cleanUp()
      }
    },
    [controller],
  )

  return (
    <VirtualizerContext.Provider value={controller?.instance}>
      <div className={className} style={style} ref={ref}>
        <div className={contentClassName} style={contentStyle}>
          {children}
        </div>
      </div>
    </VirtualizerContext.Provider>
  )
}
