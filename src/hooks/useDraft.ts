import { useCallback, useRef, useState, type SetStateAction } from 'react'

/**
 * Local edits over a saved value that comes from a query. Until the user edits,
 * `value` IS the saved value (so it fills in when the query lands, and follows a
 * refetch); the first edit forks a draft, and `reset()` drops it again — call it
 * after a save has written the server's answer back into the cache.
 */
export function useDraft<T>(saved: T) {
  const [draft, setDraft] = useState<{ value: T } | null>(null)
  const savedRef = useRef(saved)
  savedRef.current = saved

  const setValue = useCallback((update: SetStateAction<T>) => {
    setDraft((prev) => {
      const base = prev ? prev.value : savedRef.current
      return { value: typeof update === 'function' ? (update as (prev: T) => T)(base) : update }
    })
  }, [])
  const reset = useCallback(() => setDraft(null), [])

  return [draft ? draft.value : saved, setValue, reset, draft != null] as const
}
