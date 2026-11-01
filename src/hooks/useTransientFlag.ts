import { useCallback, useEffect, useRef, useState } from "react"

/**
 * A flag that turns itself off: "Saved ✓", "Copied", a brief error tick.
 *
 * Returns `[on, flash, clear]`. `flash()` turns it on and restarts the timer, so
 * a second save inside the window doesn't get cut short by the first one's
 * timeout; `clear()` turns it off now (e.g. when a new attempt starts). The
 * timer is cancelled on unmount.
 */
export function useTransientFlag(durationMs = 2000): [boolean, () => void, () => void] {
  const [on, setOn] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const flash = useCallback(() => {
    window.clearTimeout(timer.current)
    setOn(true)
    timer.current = window.setTimeout(() => setOn(false), durationMs)
  }, [durationMs])

  const clear = useCallback(() => {
    window.clearTimeout(timer.current)
    setOn(false)
  }, [])

  return [on, flash, clear]
}
