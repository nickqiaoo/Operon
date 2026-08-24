import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useIsMobile } from '../hooks/useIsMobile'
import { useIsCompactViewport } from '../hooks/useIsCompactViewport'
import { ZoomableImage } from './ImageZoom'
import channelImg from '../assets/channel.png'
import slackImg from '../assets/slack.png'

type Surface = 'operon' | 'slack'

const SURFACE_ORDER: Surface[] = ['operon', 'slack']
const SURFACE_ROTATION_INTERVAL = 4200
const MANUAL_SELECTION_PAUSE = 9000
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

const SURFACES: Record<Surface, {
  label: string
  img: string
  alt: string
  dot: string
  bg: string
  border: string
}> = {
  operon: {
    label: 'Operon Channels',
    img: channelImg,
    alt: 'Operon Channel with multi-agent thread side-panel',
    dot: 'rgba(99,102,241,0.95)',
    bg: 'rgba(99,102,241,0.16)',
    border: 'rgba(99,102,241,0.45)',
  },
  slack: {
    label: 'Slack groups',
    img: slackImg,
    alt: 'Operon agents collaborating inside a Slack channel',
    dot: 'rgba(167,139,250,0.95)',
    bg: 'rgba(139,92,246,0.18)',
    border: 'rgba(167,139,250,0.45)',
  },
}

function subscribeReducedMotion(onStoreChange: () => void) {
  const mql = window.matchMedia(REDUCED_MOTION_QUERY)
  mql.addEventListener('change', onStoreChange)
  return () => mql.removeEventListener('change', onStoreChange)
}

function getReducedMotionSnapshot() {
  if (typeof window === 'undefined') return false
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

function usePrefersReducedMotion() {
  return useSyncExternalStore(subscribeReducedMotion, getReducedMotionSnapshot, () => false)
}

const FEATURES = [
  {
    title: '@Mention like a coworker',
    desc: 'Type @claude or @codex. They reply in-thread, pick up context, ask back.',
  },
  {
    title: 'Multi-agent in one room',
    desc: 'Pull two or more agents in. Let them disagree. You moderate.',
  },
  {
    title: 'Threads & Tasks',
    desc: 'Side-conversations stay focused. Outcomes become tracked tasks inside the channel.',
  },
  {
    title: 'Pick your home turf',
    desc: "Use Operon's built-in Channels for a focused agent workspace — or drop them into your team's Slack and every group becomes an agent-ready room.",
  },
]

export function ChannelsSection() {
  const mobile = useIsMobile()
  const compactViewport = useIsCompactViewport()
  const prefersReducedMotion = usePrefersReducedMotion()
  const scrollableViewport = mobile || compactViewport
  const manualPauseUntil = useRef(0)
  const [active, setActive] = useState<Surface>('operon')

  useEffect(() => {
    if (prefersReducedMotion || SURFACE_ORDER.length < 2) return

    const interval = window.setInterval(() => {
      if (performance.now() < manualPauseUntil.current) return

      setActive((current) => {
        const currentIndex = SURFACE_ORDER.indexOf(current)
        const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % SURFACE_ORDER.length
        return SURFACE_ORDER[nextIndex]
      })
    }, SURFACE_ROTATION_INTERVAL)

    return () => window.clearInterval(interval)
  }, [prefersReducedMotion])

  const handleSelectSurface = (key: Surface, eventTime: number) => {
    manualPauseUntil.current = eventTime + MANUAL_SELECTION_PAUSE
    setActive(key)
  }

  return (
    <section
      style={{
        position: 'relative',
        height: '100%',
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      {/* Background glow */}
      <div
        style={{
          position: 'absolute',
          width: 900,
          height: 900,
          borderRadius: '50%',
          top: '50%',
          left: '-5%',
          transform: 'translateY(-50%)',
          background: 'radial-gradient(circle, rgba(99,102,241,0.08) 0%, transparent 70%)',
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 600,
          height: 600,
          borderRadius: '50%',
          bottom: '15%',
          right: '10%',
          background: 'radial-gradient(circle, rgba(139,92,246,0.05) 0%, transparent 70%)',
          pointerEvents: 'none',
        }}
      />

      {/* Content */}
      <div
        data-scrollable
        style={{
          display: 'flex',
          flexDirection: mobile ? 'column' : 'row',
          alignItems: mobile ? 'stretch' : compactViewport ? 'flex-start' : 'center',
          gap: mobile ? 24 : 80,
          width: '90vw',
          maxWidth: 1400,
          ...(scrollableViewport
            ? {
                height: '100%',
                paddingTop: mobile ? 72 : 96,
                paddingBottom: mobile ? 24 : 56,
                overflow: 'auto',
              }
            : {}),
        }}
      >
        {/* Left: text */}
        <div style={{ width: mobile ? '100%' : 460, flexShrink: 0 }}>
          <p
            style={{
              fontSize: 12,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'rgba(255,255,255,0.3)',
              marginBottom: mobile ? 10 : 16,
              fontWeight: 500,
            }}
          >
            Channels
          </p>
          <h2
            style={{
              fontSize: mobile ? 30 : 50,
              fontWeight: 600,
              color: 'rgba(255,255,255,0.92)',
              lineHeight: 1.1,
              letterSpacing: '-0.025em',
              marginBottom: mobile ? 14 : 24,
            }}
          >
            Agents, but treat them
            <br />
            <span style={{ color: 'rgba(99,102,241,0.8)' }}>like teammates.</span>
          </h2>

          <p
            style={{
              fontSize: mobile ? 14 : 19,
              lineHeight: 1.75,
              color: 'rgba(255,255,255,0.4)',
              fontWeight: 300,
              marginBottom: mobile ? 20 : 36,
            }}
          >
            Invite an agent into a chat room. @mention it, debate with it,
            watch two agents argue and decide which one's right.
          </p>

          {/* Feature list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: mobile ? 14 : 20 }}>
            {FEATURES.map((item, i) => (
              <div key={i} style={{ display: 'flex', gap: mobile ? 10 : 16 }}>
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    backgroundColor: '#6366f1',
                    opacity: 0.55,
                    marginTop: 8,
                    flexShrink: 0,
                  }}
                />
                <div>
                  <div
                    style={{
                      fontSize: mobile ? 14 : 16,
                      fontWeight: 500,
                      color: 'rgba(255,255,255,0.82)',
                      marginBottom: 4,
                    }}
                  >
                    {item.title}
                  </div>
                  <div
                    style={{
                      fontSize: mobile ? 12 : 14,
                      lineHeight: 1.6,
                      color: 'rgba(255,255,255,0.36)',
                      fontWeight: 300,
                    }}
                  >
                    {item.desc}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: screenshot frame */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: mobile ? 12 : 16,
            ...(mobile ? {} : { marginRight: -40 }),
          }}
        >
          <div
            style={{
              position: 'relative',
              aspectRatio: '16 / 10',
              width: mobile ? '100%' : 'calc(100% + 40px)',
            }}
          >
            {SURFACE_ORDER.map((key) => {
              const surface = SURFACES[key]
              const isActive = active === key
              return (
                <div
                  key={key}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    borderRadius: mobile ? 14 : 20,
                    overflow: 'hidden',
                    border: '1px solid rgba(255,255,255,0.1)',
                    boxShadow: '0 30px 90px rgba(0,0,0,0.6)',
                    opacity: isActive ? 1 : 0,
                    transform: prefersReducedMotion
                      ? 'none'
                      : isActive
                        ? 'translateY(0) scale(1)'
                        : 'translateY(12px) scale(0.985)',
                    transition: prefersReducedMotion
                      ? 'none'
                      : 'opacity 380ms cubic-bezier(0.4, 0, 0.2, 1), transform 480ms cubic-bezier(0.4, 0, 0.2, 1)',
                    pointerEvents: isActive ? 'auto' : 'none',
                    zIndex: isActive ? 2 : 1,
                  }}
                >
                  <ZoomableImage
                    src={surface.img}
                    alt={surface.alt}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                </div>
              )
            })}
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              fontSize: mobile ? 11 : 12,
              color: 'rgba(255,255,255,0.35)',
              letterSpacing: '0.08em',
              fontWeight: 500,
            }}
          >
            <span style={{ textTransform: 'uppercase' }}>Works in</span>
            {SURFACE_ORDER.map((key, idx) => {
              const surface = SURFACES[key]
              const isActive = active === key
              return (
                <span key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                  {idx > 0 && <span style={{ color: 'rgba(255,255,255,0.2)' }}>·</span>}
                  <button
                    type="button"
                    onClick={(event) => handleSelectSurface(key, event.timeStamp)}
                    aria-pressed={isActive}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '5px 11px',
                      borderRadius: 999,
                      background: isActive ? surface.bg : 'rgba(255,255,255,0.03)',
                      border: `1px solid ${isActive ? surface.border : 'rgba(255,255,255,0.08)'}`,
                      color: isActive ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.55)',
                      cursor: 'pointer',
                      transition:
                        'background 280ms ease, border-color 280ms ease, color 280ms ease, transform 280ms ease',
                      transform: isActive ? 'translateY(-1px)' : 'translateY(0)',
                      fontSize: 'inherit',
                      letterSpacing: 'inherit',
                      fontWeight: 'inherit',
                      fontFamily: 'inherit',
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive) {
                        e.currentTarget.style.color = 'rgba(255,255,255,0.85)'
                        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.18)'
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive) {
                        e.currentTarget.style.color = 'rgba(255,255,255,0.55)'
                        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'
                      }
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        backgroundColor: isActive ? surface.dot : 'rgba(255,255,255,0.3)',
                        transition: 'background-color 280ms ease',
                      }}
                    />
                    {surface.label}
                  </button>
                </span>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}
