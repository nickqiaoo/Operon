import { useCallback, useSyncExternalStore } from 'react'

interface CompactViewportOptions {
  maxHeight?: number
  minWidth?: number
}

export function useIsCompactViewport({
  maxHeight = 820,
  minWidth = 768,
}: CompactViewportOptions = {}) {
  const getSnapshot = useCallback(() => {
    if (typeof window === 'undefined') return false
    return window.innerWidth >= minWidth && window.innerHeight <= maxHeight
  }, [maxHeight, minWidth])

  const subscribe = useCallback((onStoreChange: () => void) => {
    window.addEventListener('resize', onStoreChange)
    return () => window.removeEventListener('resize', onStoreChange)
  }, [])

  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
