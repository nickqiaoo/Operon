import { useEffect, useSyncExternalStore } from "react"
import { hasNativeTabBar } from "@/lib/native"

// Full-screen web overlays (bottom sheets, the phone thread panel) can't cover
// the native tab bar — it is a real view above the web view — so while one is
// open the bar has to get out of the way. This is a plain counter: every open
// overlay holds one slot, and MobileApp hides the bar while any slot is held.

let overlayCount = 0
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notify() {
  for (const listener of listeners) listener()
}

/** Hold a slot while `active`. No-op outside the iOS app. */
export function useNativeShellOverlay(active: boolean): void {
  useEffect(() => {
    if (!active || !hasNativeTabBar()) return
    overlayCount += 1
    notify()
    return () => {
      overlayCount -= 1
      notify()
    }
  }, [active])
}

/** How many overlays currently hold a slot. */
export function useNativeShellOverlayCount(): number {
  return useSyncExternalStore(subscribe, () => overlayCount, () => 0)
}
