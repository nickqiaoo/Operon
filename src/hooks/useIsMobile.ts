import { useSyncExternalStore } from "react"

// Phone-sized viewport. Matches a real device or a desktop browser dragged
// narrow, so the mobile shell is a pure runtime decision (no build flag).
const MOBILE_QUERY = "(max-width: 768px)"

function subscribe(callback: () => void) {
  const mql = window.matchMedia(MOBILE_QUERY)
  mql.addEventListener("change", callback)
  return () => mql.removeEventListener("change", callback)
}

function getSnapshot() {
  return window.matchMedia(MOBILE_QUERY).matches
}

/**
 * `true` when the viewport is phone-sized. Backed by `matchMedia` via
 * `useSyncExternalStore` so it stays in sync with orientation/resize without a
 * resize-listener race. SSR/headless falls back to `false` (desktop shell).
 */
export function useIsMobile() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
