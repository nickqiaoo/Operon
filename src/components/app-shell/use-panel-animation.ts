import { useEffect, useState } from "react"
import {
  cubicBezier,
  useMotionValue,
  useMotionValueEvent,
  useTransform,
  type MotionValue,
} from "motion/react"
import { PANEL_ANIMATION_DURATION } from "./constants"

interface PanelAnimationOptions {
  /** Target size in px when fully open (width for right panel, height for bottom). */
  size: number
  /** Whether the panel should currently be open. */
  isVisible: boolean
}

interface PanelAnimationResult {
  /**
   * Whether the panel DOM should be rendered. True while open OR while closing
   * animation is in flight (so we can animate to 0 before unmounting).
   */
  isMounted: boolean
  /**
   * Whether the panel has ever been open. Panels render from first open on and
   * stay mounted while closed — unmounting threw away their content (file
   * tree, loaded preview, rendered markdown, terminals…), so every reopen
   * re-fetched and re-rendered it.
   */
  hasOpened: boolean
  /**
   * Fully closed (close animation finished) — what used to mean "unmounted".
   * Bind to `inert` / `invisible` on the panel root, and treat tabs as inactive.
   */
  collapsed: boolean
  /** 0..1 opacity tied to progress; bind to style.opacity. */
  opacity: MotionValue<number>
  /** 0..size px; bind to style.width or style.height. */
  animatedSize: MotionValue<number>
  /** Raw 0..1 progress value. Subscribe via useMotionValueEvent to trigger layout work. */
  progress: MotionValue<number>
}

const panelEase = cubicBezier(0.22, 1, 0.36, 1)
/** Longest step one frame may take: a 60Hz frame plus slack, so normal frames keep real time. */
const MAX_FRAME_STEP_MS = 20

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/**
 * Drives the open/close animation of a panel.
 *
 * Mirrors Codex's `Ie()` hook: a single MotionValue (`progress`) drives both
 * opacity and animated size. Component stays mounted until progress returns
 * to 0 so the closing animation completes before unmount.
 */
export function usePanelAnimation({
  size,
  isVisible,
}: PanelAnimationOptions): PanelAnimationResult {
  const progress = useMotionValue(isVisible ? 1 : 0)
  const animatedSize = useTransform(progress, (p) => clamp01(p) * size)

  useEffect(() => {
    const from = progress.get()
    const to = isVisible ? 1 : 0
    if (from === to) return
    // Our own frame loop instead of motion's `animate`, which is time-based: a
    // toggle that also mounts a page (Board: ~100ms of render, then a ~30ms
    // frame) dropped every frame of the 220ms tween, so it painted the start
    // and then ~70% of the way in one step — the Board "lurched" left as the
    // panel made way. Each frame here advances at most one frame's worth of
    // time, so a blocked main thread stretches the animation instead of
    // skipping it.
    let elapsed = 0
    let last: number | null = null
    let frame = requestAnimationFrame(function step(now) {
      if (last != null) elapsed += Math.min(now - last, MAX_FRAME_STEP_MS)
      last = now
      const t = Math.min(1, elapsed / (PANEL_ANIMATION_DURATION * 1000))
      progress.set(from + (to - from) * panelEase(t))
      if (t < 1) frame = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(frame)
  }, [isVisible, progress])

  const [isMounted, setIsMounted] = useState(
    () => isVisible || progress.get() > 0
  )

  useMotionValueEvent(progress, "change", (value) => {
    const nextMounted = isVisible || value > 0
    setIsMounted((prev) => (prev === nextMounted ? prev : nextMounted))
  })

  const [hasOpened, setHasOpened] = useState(isVisible)
  if (isVisible && !hasOpened) setHasOpened(true)

  return {
    isMounted,
    hasOpened,
    collapsed: !isVisible && !isMounted,
    opacity: progress,
    animatedSize,
    progress,
  }
}
