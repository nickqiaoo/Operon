import type { ReactNode } from 'react'
import { useIsMobile } from '../hooks/useIsMobile'

/**
 * Shared type scale for every section on the landing page.
 *
 * On the fullpage build each section sized its own heading to fit whatever was
 * left of its viewport, so headings drifted between 30/32px on mobile and
 * 50/52px on desktop and body copy between 14 and 20px. On a continuous page
 * those inconsistencies read as sloppiness rather than variety, because the
 * user now sees two sections at once. One scale, used everywhere.
 */

export function Eyebrow({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  const mobile = useIsMobile()

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginBottom: mobile ? 12 : 18,
        flexWrap: 'wrap',
      }}
    >
      <p
        style={{
          fontSize: 12,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'rgba(255,255,255,0.32)',
          fontWeight: 500,
        }}
      >
        {children}
      </p>
      {trailing}
    </div>
  )
}

export function SectionTitle({
  children,
  align = 'start',
}: {
  children: ReactNode
  align?: 'start' | 'center'
}) {
  const mobile = useIsMobile()

  return (
    <h2
      style={{
        fontSize: mobile ? 30 : 'clamp(38px, 3.6vw, 50px)',
        fontWeight: 600,
        color: 'rgba(255,255,255,0.93)',
        lineHeight: 1.12,
        letterSpacing: '-0.025em',
        marginBottom: mobile ? 14 : 22,
        textAlign: align === 'center' ? 'center' : undefined,
      }}
    >
      {children}
    </h2>
  )
}

export function Lead({
  children,
  align = 'start',
  maxWidth,
}: {
  children: ReactNode
  align?: 'start' | 'center'
  maxWidth?: number
}) {
  const mobile = useIsMobile()

  return (
    <p
      style={{
        fontSize: mobile ? 15 : 18,
        lineHeight: 1.72,
        color: 'rgba(255,255,255,0.42)',
        fontWeight: 300,
        marginBottom: mobile ? 24 : 34,
        maxWidth,
        ...(align === 'center' ? { textAlign: 'center', marginInline: 'auto' } : {}),
      }}
    >
      {children}
    </p>
  )
}

/** Bulleted feature list — the dominant pattern across sections. */
export function FeatureList({
  items,
  accent,
  columns = 1,
}: {
  items: { title: string; desc: string }[]
  accent: string
  columns?: 1 | 2
}) {
  const mobile = useIsMobile()
  const twoUp = columns === 2 && !mobile

  return (
    <div
      style={{
        display: twoUp ? 'grid' : 'flex',
        ...(twoUp
          ? { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', columnGap: 26, rowGap: 20 }
          : { flexDirection: 'column', gap: mobile ? 16 : 20 }),
      }}
    >
      {items.map((item) => (
        <div key={item.title} style={{ display: 'flex', gap: mobile ? 11 : 14 }}>
          <div
            style={{
              width: 12,
              height: 1,
              borderRadius: 999,
              backgroundColor: accent,
              opacity: 0.7,
              marginTop: mobile ? 11 : 12,
              flexShrink: 0,
            }}
          />
          <div>
            <div
              style={{
                fontSize: mobile ? 14 : 15,
                fontWeight: 500,
                color: 'rgba(255,255,255,0.82)',
                marginBottom: 4,
              }}
            >
              {item.title}
            </div>
            <div
              style={{
                fontSize: mobile ? 13 : 14,
                lineHeight: 1.65,
                color: 'rgba(255,255,255,0.38)',
                fontWeight: 300,
              }}
            >
              {item.desc}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

/** Compact one-line capability cards (adapters, clients). */
export function FeatureChips({
  items,
  accent,
  columns = 2,
}: {
  items: string[]
  accent: string
  columns?: 1 | 2
}) {
  const mobile = useIsMobile()

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: mobile || columns === 1 ? '1fr' : 'repeat(2, minmax(0, 1fr))',
        gap: mobile ? 8 : 12,
      }}
    >
      {items.map((item) => (
        <div
          key={item}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: mobile ? 10 : 13,
            padding: mobile ? '12px 14px' : '14px 18px',
            borderRadius: 12,
            background: 'rgba(255,255,255,0.025)',
            border: '1px solid rgba(255,255,255,0.05)',
          }}
        >
          <div
            style={{
              width: 10,
              height: 1,
              borderRadius: 999,
              backgroundColor: accent,
              opacity: 0.65,
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: mobile ? 13 : 14,
              color: 'rgba(255,255,255,0.52)',
              lineHeight: 1.5,
            }}
          >
            {item}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * Two-column section body: copy on the left, visual on the right. Collapses to
 * a single column on mobile, where the visual always follows the copy.
 */
export function SplitLayout({
  copy,
  visual,
  copyWidth = 440,
  gap,
  align = 'center',
  divider = false,
  reverse = false,
}: {
  copy: ReactNode
  visual: ReactNode
  copyWidth?: number
  gap?: number
  align?: 'center' | 'start'
  /** Hairline between the two columns. Desktop only — stacked columns read as
   *  separate already, and a horizontal rule between them would just be noise. */
  divider?: boolean
  /** Flip the two desktop columns while preserving copy-first reading order on mobile. */
  reverse?: boolean
}) {
  const mobile = useIsMobile()

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: mobile ? 'column' : reverse ? 'row-reverse' : 'row',
        alignItems: mobile ? 'stretch' : align === 'center' ? 'center' : 'flex-start',
        gap: mobile ? 32 : (gap ?? 72),
      }}
    >
      <div style={{ width: mobile ? '100%' : copyWidth, flexShrink: 0, minWidth: 0 }}>{copy}</div>
      {divider && !mobile && (
        <div
          aria-hidden
          style={{
            width: 1,
            alignSelf: 'stretch',
            background:
              'linear-gradient(180deg, transparent, rgba(255,255,255,0.08) 12%, rgba(255,255,255,0.08) 88%, transparent)',
            flexShrink: 0,
          }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0, width: mobile ? '100%' : undefined }}>{visual}</div>
    </div>
  )
}

/**
 * Standard framing for a product screenshot.
 *
 * The old sections each let their image bleed past the column with negative
 * margins to fill a viewport-height pane. At a fixed reading width that trick
 * only risks horizontal overflow, so images sit inside the column now.
 */
export function ScreenshotFrame({
  children,
  aspectRatio,
}: {
  children: ReactNode
  aspectRatio?: string
}) {
  const mobile = useIsMobile()

  return (
    <div
      style={{
        width: '100%',
        aspectRatio,
        borderRadius: mobile ? 14 : 18,
        overflow: 'hidden',
        border: '1px solid rgba(255,255,255,0.08)',
        background: 'rgba(255,255,255,0.03)',
        boxShadow: '0 30px 80px rgba(0,0,0,0.45)',
      }}
    >
      {children}
    </div>
  )
}
