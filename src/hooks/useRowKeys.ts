import { useRef } from "react"

/**
 * Stable React keys for an editable list whose items carry no id of their own
 * (key/value pairs, condition rows, env vars — persisted shapes we don't want to
 * grow an `id` field just for rendering).
 *
 * `key={index}` breaks the moment a middle row is deleted: React keeps the DOM
 * and component state of row N and hands it row N+1's props, so a focused
 * input, an open variable picker or an IME composition jumps to the wrong row.
 *
 * Keys follow the list's length (new rows get fresh keys, a list replaced from
 * outside is trimmed / extended), and `remove(i)` — called next to the
 * `onChange` that drops row `i` — takes that row's key with it, so every row
 * after it keeps its own. Rows are only ever appended or removed; there is no
 * reorder.
 */
export function useRowKeys(count: number): { keys: readonly number[]; remove: (index: number) => void } {
  const seq = useRef(0)
  const keys = useRef<number[]>([])
  // Idempotent for a given `count`, so a repeated (StrictMode) render is harmless.
  while (keys.current.length < count) keys.current.push(seq.current++)
  if (keys.current.length > count) keys.current.length = count
  return {
    keys: keys.current,
    remove: (index) => {
      keys.current.splice(index, 1)
    },
  }
}
