import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react"
import { HOVER_CARD_CLOSE_DELAY_MS, HOVER_CARD_OPEN_DELAY_MS } from "@/components/ui/hover-card"

export type RailFlyoutKind = "projects" | "inbox"

interface RailFlyout {
  kind: RailFlyoutKind
  /** Pinned ones ignore the pointer leaving and wait for an explicit dismiss. */
  pinned: boolean
}

/** With one panel already out, moving to the other trigger is a clear intent. */
const RAIL_FLYOUT_SWITCH_DELAY_MS = 150

/**
 * Which panel floats out of the collapsed rail. One timer serves both
 * directions, so a newer intent always replaces the pending one. Touch pointers
 * are ignored: a tap fires enter and leave together and should act as a click.
 */
export function useRailFlyout() {
  const [flyout, setFlyout] = useState<RailFlyout | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const clearTimer = useCallback(() => clearTimeout(timerRef.current), [])
  useEffect(() => clearTimer, [clearTimer])

  const close = useCallback(() => {
    clearTimer()
    setFlyout(null)
  }, [clearTimer])

  const pin = useCallback((kind: RailFlyoutKind) => {
    clearTimer()
    setFlyout({ kind, pinned: true })
  }, [clearTimer])

  /** Keeps whatever is open in place, e.g. while a dialog it launched is up. */
  const holdOpen = useCallback(() => {
    clearTimer()
    setFlyout((current) => current && { ...current, pinned: true })
  }, [clearTimer])

  const scheduleOpen = (kind: RailFlyoutKind) => {
    clearTimer()
    if (flyout?.kind === kind) return
    const delay = flyout && !flyout.pinned ? RAIL_FLYOUT_SWITCH_DELAY_MS : HOVER_CARD_OPEN_DELAY_MS
    timerRef.current = setTimeout(() => setFlyout({ kind, pinned: false }), delay)
  }

  const scheduleClose = () => {
    clearTimer()
    if (!flyout || flyout.pinned) return
    timerRef.current = setTimeout(() => setFlyout(null), HOVER_CARD_CLOSE_DELAY_MS)
  }

  const onPointerLeave = (event: PointerEvent) => {
    if (event.pointerType !== "touch") scheduleClose()
  }

  const triggerHover = (kind: RailFlyoutKind) => ({
    onPointerEnter: (event: PointerEvent) => {
      if (event.pointerType !== "touch") scheduleOpen(kind)
    },
    onPointerLeave,
  })

  const panelHover = {
    onPointerEnter: (event: PointerEvent) => {
      if (event.pointerType !== "touch") clearTimer()
    },
    onPointerLeave,
  }

  return { flyout, close, pin, holdOpen, triggerHover, panelHover }
}
