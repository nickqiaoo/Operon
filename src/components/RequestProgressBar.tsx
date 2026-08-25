import { useEffect, useState, useSyncExternalStore } from "react"
import { getInFlightCount, subscribeInFlight } from "@/lib/request-progress"

/**
 * Delay before a pending request is worth telling the user about. Below this a
 * bar would only flicker — on the desktop app, where the backend is a local
 * process, essentially nothing crosses it, so this component is invisible there
 * without needing a target check. On web every call is a WAN round trip through
 * the broker tunnel, and this is exactly the "did my click do anything?" gap.
 */
const SHOW_AFTER_MS = 300

/**
 * Thin indeterminate bar pinned to the top of the window while a tracked load is
 * outstanding — today only opening a conversation and waiting for its
 * transcript. Content-free by design: it answers "did my click land, is
 * something coming", nothing more. See `request-progress.ts` before adding a
 * call site; a bar that is on for every background poll says nothing.
 */
export function RequestProgressBar() {
  const inFlight = useSyncExternalStore(subscribeInFlight, getInFlightCount, getInFlightCount)
  // Gate on "busy at all", not the count: keying the timer to the number would
  // restart the delay every time a second request joined, so a steady stream of
  // short calls could stay hidden forever.
  const busy = inFlight > 0
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!busy) {
      setVisible(false)
      return
    }
    const timer = setTimeout(() => setVisible(true), SHOW_AFTER_MS)
    return () => clearTimeout(timer)
  }, [busy])

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5 overflow-hidden transition-opacity duration-200"
      style={{ opacity: visible ? 1 : 0 }}
    >
      {visible && <div className="animate-request-progress h-full w-2/5 bg-tint/70" />}
    </div>
  )
}
