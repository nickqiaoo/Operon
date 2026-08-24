import { useEffect, useState } from "react"
import {
  animate,
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
  /** 0..1 opacity tied to progress; bind to style.opacity. */
  opacity: MotionValue<number>
  /** 0..size px; bind to style.width or style.height. */
  animatedSize: MotionValue<number>
  /** Raw 0..1 progress value. Subscribe via useMotionValueEvent to trigger layout work. */
  progress: MotionValue<number>
}

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
    const controls = animate(progress, isVisible ? 1 : 0, {
      duration: PANEL_ANIMATION_DURATION,
      ease: [0.22, 1, 0.36, 1],
    })
    return () => controls.stop()
  }, [isVisible, progress])

  const [isMounted, setIsMounted] = useState(
    () => isVisible || progress.get() > 0
  )

  useMotionValueEvent(progress, "change", (value) => {
    const nextMounted = isVisible || value > 0
    setIsMounted((prev) => (prev === nextMounted ? prev : nextMounted))
  })

  return { isMounted, opacity: progress, animatedSize, progress }
}
