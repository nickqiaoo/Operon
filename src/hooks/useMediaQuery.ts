import { useCallback, useSyncExternalStore } from "react"

/**
 * `true` while `query` matches. Backed by `matchMedia` via
 * `useSyncExternalStore`, so it follows resizes and rotation without a
 * resize-listener race. SSR/headless falls back to `false`.
 */
export function useMediaQuery(query: string) {
  const subscribe = useCallback((callback: () => void) => {
    const mql = window.matchMedia(query)
    mql.addEventListener("change", callback)
    return () => mql.removeEventListener("change", callback)
  }, [query])
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false)
}
