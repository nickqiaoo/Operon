import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ZoomableImage } from './ImageZoom'
import { SectionShell } from './SectionShell'
import { Reveal } from './Reveal'
import { SectionTitle, Lead, FeatureList, SplitLayout } from './SectionType'
import { useIsMobile } from '../hooks/useIsMobile'
import channelImg from '../assets/channel.png'
import slackImg from '../assets/slack.png'

type Surface = 'operon' | 'slack'

const ACCENT = '#6366f1'
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
    desc: "Use Operon's built-in Channels for a focused agent workspace. Or drop them into your team's Slack and every group becomes an agent-ready room.",
  },
]

export function ChannelsSection() {
  const mobile = useIsMobile()
  const prefersReducedMotion = usePrefersReducedMotion()
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
    <SectionShell id="channels" accent={ACCENT} glow="left">
      <SplitLayout
        copyWidth={460}
        copy={
          <Reveal>
            <SectionTitle>
              Agents, but treat them
              <br />
              <span style={{ color: 'rgba(99,102,241,0.85)' }}>like teammates.</span>
            </SectionTitle>
            <Lead>
              Invite an agent into a chat room. @mention it, debate with it, watch two agents argue
              and decide which one's right.
            </Lead>
            <FeatureList items={FEATURES} accent={ACCENT} />
          </Reveal>
        }
        visual={
          <Reveal delay={45}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: mobile ? 12 : 16 }}>
              <div style={{ position: 'relative', aspectRatio: '16 / 10', width: '100%' }}>
                {SURFACE_ORDER.map((key) => {
                  const surface = SURFACES[key]
                  const isActive = active === key
                  return (
                    <div
                      key={key}
                      style={{
                        position: 'absolute',
                        inset: 0,
                        borderRadius: mobile ? 14 : 18,
                        overflow: 'hidden',
                        border: '1px solid rgba(255,255,255,0.1)',
                        boxShadow: '0 30px 80px rgba(0,0,0,0.55)',
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
                  flexWrap: 'wrap',
                  fontSize: mobile ? 11 : 12,
                  color: 'rgba(255,255,255,0.35)',
                  letterSpacing: '0.08em',
                  fontWeight: 500,
                }}
              >
                <span style={{ textTransform: 'uppercase' }}>Works in</span>
                {SURFACE_ORDER.map((key) => {
                  const surface = SURFACES[key]
                  const isActive = active === key
                  return (
                    <button
                      key={key}
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
                          'background 280ms ease, border-color 280ms ease, color 280ms ease',
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
                  )
                })}
              </div>
            </div>
          </Reveal>
        }
      />
    </SectionShell>
  )
}
