import { useEffect, useSyncExternalStore } from "react"
import { hasNativeTabBar } from "@/lib/native"

// Full-screen web overlays (bottom sheets, the phone thread panel) can't cover
// the native tab bar — it is a real view above the web view — so while one is
// open the bar has to get out of the way. This is a plain counter: every open
// overlay holds one slot, and MobileApp hides the bar while any slot is held.
//
// The native top bar normally stays put (inert) under an overlay, since sheets
// leave the top of the screen visible. An overlay that takes the whole screen
// (the image viewer) holds a `fullscreen` slot too, and the top bar hides for it.

let overlayCount = 0
let fullscreenCount = 0
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

/** Hold a slot while `active`. No-op outside the packaged apps. */
export function useNativeShellOverlay(active: boolean, options?: { fullscreen?: boolean }): void {
  const fullscreen = options?.fullscreen ?? false
  useEffect(() => {
    if (!active || !hasNativeTabBar()) return
    overlayCount += 1
    if (fullscreen) fullscreenCount += 1
    notify()
    return () => {
      overlayCount -= 1
      if (fullscreen) fullscreenCount -= 1
      notify()
    }
  }, [active, fullscreen])
}

/** How many overlays currently hold a slot. */
export function useNativeShellOverlayCount(): number {
  return useSyncExternalStore(subscribe, () => overlayCount, () => 0)
}

/** How many of them cover the whole screen, native top bar included. */
export function useNativeShellFullscreenCount(): number {
  return useSyncExternalStore(subscribe, () => fullscreenCount, () => 0)
}
