import { useEffect, type RefObject } from 'react'

/** How long after the last scroll event the element stops counting as "scrolling". */
const SCROLL_IDLE_MS = 900

/**
 * Marks a scroll container with `data-scrolling="true"` while the user is
 * actively scrolling it, and clears the flag shortly after they stop.
 *
 * Pair it with the `.transcript-scrollbar` utility: a long transcript's mouse
 * is almost always somewhere inside the list, so a hover-revealed scrollbar
 * (`.code-scrollbar`) is effectively permanent there. Revealing only on
 * activity gives the macOS overlay-scrollbar feel back.
 */
export function useScrollActivity(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const onScroll = () => {
      if (el.dataset.scrolling !== 'true') el.dataset.scrolling = 'true'
      if (timer != null) clearTimeout(timer)
      timer = setTimeout(() => {
        delete el.dataset.scrolling
        timer = null
      }, SCROLL_IDLE_MS)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (timer != null) clearTimeout(timer)
      delete el.dataset.scrolling
    }
  }, [ref])
}
