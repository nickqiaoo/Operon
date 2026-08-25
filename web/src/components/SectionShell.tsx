import type { CSSProperties, ReactNode } from 'react'
import { useIsMobile } from '../hooks/useIsMobile'

/**
 * The page is one continuous scroll, so a section no longer owns a viewport.
 * Rhythm comes from vertical padding and a shared reading width instead of
 * from `height: 100%` + a page-flip — that's what keeps the flow from reading
 * as twelve stacked slides.
 *
 * Note that `paddingBlock` is HALF the gap you see between two sections: the
 * previous section's bottom padding and the next one's top padding stack. The
 * generous per-side value carried over from the fullpage build was right when
 * each section was centred in its own viewport and nothing followed it on
 * screen; here it just opened a hole. Read these numbers as doubled.
 */
export function SectionShell({
  id,
  accent,
  glow = 'right',
  divider = true,
  maxWidth = 1360,
  children,
  style,
}: {
  id?: string
  /** Chapter tint. Kept faint and one-sided so scrolling reads as a slow
   *  temperature shift rather than a rainbow of full-screen blurs. */
  accent?: string
  glow?: 'left' | 'right' | 'center' | 'none'
  divider?: boolean
  maxWidth?: number
  children: ReactNode
  style?: CSSProperties
}) {
  const mobile = useIsMobile()

  return (
    <section
      id={id}
      style={{
        position: 'relative',
        width: '100%',
        // Clips the accent glow, which is deliberately parked half outside the
        // section. Without this it widens the document and iOS Safari lets the
        // page drag sideways — `overflow-x: hidden` on body is not reliable
        // there.
        overflow: 'hidden',
        paddingBlock: mobile ? 36 : 'clamp(52px, 4vw, 68px)',
        ...style,
      }}
    >
      {divider && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: 0,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 'min(1100px, 88vw)',
            height: 1,
            background:
              'linear-gradient(90deg, transparent, rgba(255,255,255,0.07) 22%, rgba(255,255,255,0.07) 78%, transparent)',
            pointerEvents: 'none',
          }}
        />
      )}

      {accent && glow !== 'none' && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: '50%',
            width: mobile ? 420 : 720,
            height: mobile ? 420 : 720,
            borderRadius: '50%',
            backgroundColor: accent,
            opacity: mobile ? 0.035 : 0.05,
            filter: `blur(${mobile ? 110 : 170}px)`,
            transition: 'background-color 0.6s',
            pointerEvents: 'none',
            ...(glow === 'left'
              ? { left: 0, transform: 'translate(-45%, -50%)' }
              : glow === 'right'
                ? { right: 0, transform: 'translate(45%, -50%)' }
                : { left: '50%', transform: 'translate(-50%, -50%)' }),
          }}
        />
      )}

      <div
        style={{
          position: 'relative',
          zIndex: 1,
          width: '100%',
          maxWidth,
          marginInline: 'auto',
          paddingInline: mobile ? 20 : 48,
        }}
      >
        {children}
      </div>
    </section>
  )
}
