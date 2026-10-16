import { useEffect, useState } from 'react'
import { cn } from '../lib/styles'

/** A long page needs a way back. Appears once the reader is well past the hero. */
export function BackToTop() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    let frame = 0

    const measure = () => {
      frame = 0
      setVisible(window.scrollY > window.innerHeight * 1.5)
    }

    const handleScroll = () => {
      if (frame) return
      frame = window.requestAnimationFrame(measure)
    }

    measure()
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener('scroll', handleScroll)
    }
  }, [])

  return (
    <button
      type="button"
      aria-label="Back to top"
      onClick={() => {
        window.scrollTo({
          top: 0,
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        })
      }}
      className={cn(
        'fixed right-[max(16px,env(safe-area-inset-right))] bottom-[calc(20px+env(safe-area-inset-bottom))] z-[90] flex h-9 w-9 items-center justify-center rounded-full border border-border/60 bg-popover text-muted-foreground shadow-float transition-all hover:bg-secondary-hover hover:text-foreground',
        visible ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
      )}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <line x1="12" y1="19" x2="12" y2="5" />
        <polyline points="5 12 12 5 19 12" />
      </svg>
    </button>
  )
}
