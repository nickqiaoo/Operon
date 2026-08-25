import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

/**
 * Fades content up as it scrolls into view. On the old fullpage build the
 * page-flip itself supplied the sense of arrival; on a continuous page this
 * does that job. Honours prefers-reduced-motion through `.reveal` in
 * index.css, and only ever reveals — it never hides content again on the way
 * back up, which would read as flicker.
 */
export function Reveal({
  children,
  delay = 0,
  style,
}: {
  children: ReactNode
  delay?: number
  style?: CSSProperties
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined')

  useEffect(() => {
    const el = ref.current
    if (!el || visible || typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true)
            observer.disconnect()
          }
        }
      },
      // Trigger a little before the element is fully on screen so the content
      // has finished settling by the time the user is actually looking at it.
      { rootMargin: '0px 0px 10% 0px', threshold: 0.02 }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [visible])

  return (
    <div
      ref={ref}
      className="reveal"
      data-visible={visible}
      style={{ transitionDelay: delay ? `${delay}ms` : undefined, ...style }}
    >
      {children}
    </div>
  )
}
