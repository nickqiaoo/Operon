/**
 * In-memory debounce manager.
 * Tracks a count of events per key and fires the callback once after the quiet period.
 */

interface DebounceEntry {
  timer: ReturnType<typeof setTimeout>
  count: number
}

const debouncers = new Map<string, DebounceEntry>()

/**
 * Debounce notifications for a given key.
 * Each call resets the timer; when the timer finally fires, callback receives
 * the total event count that accumulated during the quiet period.
 *
 * @param key      Unique key (e.g. `"agentId:projectId"`)
 * @param delayMs  Quiet-period length in milliseconds
 * @param callback Called once with the total accumulated count
 */
export function debounceNotify(
  key: string,
  delayMs: number,
  callback: (count: number) => void
): void {
  const existing = debouncers.get(key)

  if (existing) {
    clearTimeout(existing.timer)
    existing.count++
    existing.timer = setTimeout(() => {
      debouncers.delete(key)
      callback(existing.count)
    }, delayMs)
  } else {
    const entry: DebounceEntry = {
      count: 1,
      timer: setTimeout(() => {
        debouncers.delete(key)
        callback(entry.count)
      }, delayMs),
    }
    debouncers.set(key, entry)
  }
}

/** Cancel a pending debounce without firing the callback. */
export function cancelDebounce(key: string): void {
  const existing = debouncers.get(key)
  if (existing) {
    clearTimeout(existing.timer)
    debouncers.delete(key)
  }
}
