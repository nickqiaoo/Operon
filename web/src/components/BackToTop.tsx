import { useEffect, useState } from 'react'

/**
 * A long page needs a way back. Appears once the reader is well past the hero.
 */
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
      style={{
        position: 'fixed',
        right: 'max(16px, env(safe-area-inset-right))',
        bottom: 'calc(20px + env(safe-area-inset-bottom))',
        zIndex: 90,
        width: 40,
        height: 40,
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(14,14,20,0.72)',
        border: '1px solid rgba(255,255,255,0.1)',
        backdropFilter: 'blur(18px)',
        WebkitBackdropFilter: 'blur(18px)',
        color: 'rgba(255,255,255,0.6)',
        cursor: 'pointer',
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(10px)',
        pointerEvents: visible ? 'auto' : 'none',
        transition: 'opacity 0.3s ease, transform 0.3s ease, color 0.25s ease, border-color 0.25s ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = 'rgba(255,255,255,0.95)'
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = 'rgba(255,255,255,0.6)'
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="19" x2="12" y2="5" />
        <polyline points="5 12 12 5 19 12" />
      </svg>
    </button>
  )
}
