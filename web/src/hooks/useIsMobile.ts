import { useCallback, useSyncExternalStore } from 'react'

export function useIsMobile(breakpoint = 768) {
  const getSnapshot = useCallback(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia(`(max-width: ${breakpoint - 1}px)`).matches
  }, [breakpoint])

  const subscribe = useCallback((onStoreChange: () => void) => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
    mql.addEventListener('change', onStoreChange)
    return () => mql.removeEventListener('change', onStoreChange)
  }, [breakpoint])

  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
