import { useEffect, useState } from 'react'

/**
 * How far down the document we are, 0–1.
 *
 * Drives the navbar progress line, which replaces the twelve page-indicator
 * dots the fullpage build used — a continuous page has no page count, but it
 * still owes the reader a sense of position.
 */
export function useScrollProgress() {
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    let frame = 0

    const measure = () => {
      frame = 0
      const scrollable = document.documentElement.scrollHeight - window.innerHeight
      setProgress(scrollable <= 0 ? 0 : Math.min(window.scrollY / scrollable, 1))
    }

    const handleScroll = () => {
      if (frame) return
      frame = window.requestAnimationFrame(measure)
    }

    measure()
    window.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('resize', handleScroll, { passive: true })

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener('scroll', handleScroll)
      window.removeEventListener('resize', handleScroll)
    }
  }, [])

  return progress
}
