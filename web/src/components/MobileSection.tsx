import { useState } from 'react'
import { useIsMobile } from '../hooks/useIsMobile'
import { useIsCompactViewport } from '../hooks/useIsCompactViewport'
import { ZoomableImage } from './ImageZoom'
import tgImg from '../assets/tg.PNG'
import tgDiffImg from '../assets/tgdiff.PNG'
import slack1Img from '../assets/slack1.png'
import webappImg from '../assets/webapp.png'
import webappPwaImg from '../assets/webapppwa.PNG'

interface ChannelShot {
  frame: 'desktop' | 'phone'
  src: string
  alt: string
}

interface Channel {
  id: 'web-app' | 'android' | 'telegram' | 'slack'
  name: string
  label: string
  description: string
  features: string[]
  accent: string
  shots: ChannelShot[]
}

const CHANNELS: Channel[] = [
  {
    id: 'web-app',
    name: 'Web App',
    label: 'Desktop + mobile',
    description:
      'Use Operon in the browser on desktop or mobile. The Web App matches Desktop across sessions, projects, approvals, diffs, and tools. Remote content is end-to-end encrypted between the browser and your paired desktop.',
    features: [
      'End-to-end encrypted remote content',
      'Desktop and Web App share one UI',
      'Full feature set on desktop and mobile',
      'Same sessions, projects, approvals, and tools',
    ],
    accent: '#10b981',
    shots: [
      { frame: 'desktop', src: webappImg, alt: 'Operon Web App desktop UI' },
      { frame: 'phone', src: webappPwaImg, alt: 'Operon Web App mobile UI' },
    ],
  },
  {
    id: 'android',
    name: 'Mobile App',
    label: 'Native app · iOS + Android',
    // Download links live in the bottom CTA; this tab is about what the app
    // is, so it does not repeat them. iOS ships on the App Store, Android as
    // a signed APK served from this site.
    description:
      'Native mobile clients for iOS and Android. The iOS app is available on the App Store; Android installs from a signed APK served directly from this site. Remote content is end-to-end encrypted between the app and your paired desktop.',
    features: [
      'End-to-end encrypted remote content',
      'iOS app on the App Store',
      'Android signed APK, sideload in one tap',
      'Same sessions, approvals, and diffs as Desktop',
    ],
    accent: '#3ddc84',
    shots: [{ frame: 'phone', src: webappPwaImg, alt: 'Operon running on Android' }],
  },
  {
    id: 'telegram',
    name: 'Telegram',
    label: 'Bot · personal control',
    description:
      'Drive your agent from Telegram. Approve permissions, browse diffs in a Mini App, and continue desktop sessions on the move. Real-time streaming just like the desktop client.',
    features: [
      'One-tap permission approvals',
      'Inline syntax-highlighted diff Mini App',
      'Same session continues across desktop and Telegram',
      'Live streaming responses, not polled',
    ],
    accent: '#38a3e0',
    shots: [
      { frame: 'phone', src: tgImg, alt: 'Telegram bot chat' },
      { frame: 'phone', src: tgDiffImg, alt: 'Telegram diff Mini App' },
    ],
  },
  {
    id: 'slack',
    name: 'Slack',
    label: 'Bot · team-friendly',
    description:
      "DM the Operon bot or mention it in any channel. Approvals, diffs, and replies show up inline in your team's existing workspace with no context switch.",
    features: [
      'DM the bot for personal sessions',
      'Mention in channels for shared visibility',
      'Inline approval buttons in messages',
      'Threaded replies keep long conversations tidy',
    ],
    accent: '#a04bb4',
    shots: [{ frame: 'phone', src: slack1Img, alt: 'Operon Slack bot' }],
  },
]

export function MobileSection() {
  const [activeId, setActiveId] = useState<Channel['id']>('web-app')
  const active = CHANNELS.find((c) => c.id === activeId) ?? CHANNELS[0]
  const mobile = useIsMobile()
  const compactViewport = useIsCompactViewport()
  const scrollableViewport = mobile || compactViewport

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
          width: 800,
          height: 800,
          borderRadius: '50%',
          top: '50%',
          left: '30%',
          transform: 'translate(-50%, -50%)',
          backgroundColor: active.accent,
          opacity: 0.05,
          filter: 'blur(200px)',
          transition: 'background-color 0.6s',
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 600,
          height: 600,
          borderRadius: '50%',
          bottom: '20%',
          right: '20%',
          background: 'radial-gradient(circle, rgba(99,102,241,0.04) 0%, transparent 70%)',
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
        {/* Left: heading + channel tabs */}
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
            Web App, Native Mobile & Messaging
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
            Code from anywhere.
            <br />
            <span style={{ color: `${active.accent}cc`, transition: 'color 0.4s' }}>
              Same UI, same features.
            </span>
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
            Use the full Web App or a native client from anywhere. Remote content
            stays end-to-end encrypted between each paired device and your desktop.
            Messaging channels handle lightweight workflows.
          </p>

          {/* Tabs */}
          <div
            style={{
              display: 'flex',
              flexDirection: mobile ? 'row' : 'column',
              gap: mobile ? 8 : 6,
              ...(mobile ? { overflowX: 'auto', paddingBottom: 8 } : {}),
            }}
          >
            {CHANNELS.map((c) => {
              const isActive = c.id === activeId
              return (
                <div
                  key={c.id}
                  onClick={() => setActiveId(c.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    padding: '12px 16px',
                    borderRadius: mobile ? 12 : 16,
                    background: isActive ? 'rgba(255,255,255,0.05)' : 'transparent',
                    cursor: 'pointer',
                    transition: 'background 0.4s',
                    flexShrink: 0,
                    ...(mobile ? { minWidth: 'fit-content' } : {}),
                  }}
                >
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: isActive ? `${c.accent}26` : 'rgba(255,255,255,0.03)',
                      flexShrink: 0,
                      transition: 'background 0.4s',
                    }}
                  >
                    <ChannelIcon id={c.id} color={isActive ? c.accent : 'rgba(255,255,255,0.3)'} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: mobile ? 14 : 16,
                        fontWeight: 500,
                        color: isActive ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.3)',
                        whiteSpace: 'nowrap',
                        transition: 'color 0.4s',
                      }}
                    >
                      {c.name}
                    </div>
                    {!mobile && (
                      <div
                        style={{
                          fontSize: 12,
                          color: isActive ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.15)',
                          transition: 'color 0.4s',
                          marginTop: 2,
                        }}
                      >
                        {c.label}
                      </div>
                    )}
                  </div>
                  {isActive && !mobile && (
                    <div
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        backgroundColor: c.accent,
                        opacity: 0.7,
                      }}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Divider */}
        {!mobile && (
          <div style={{ width: 1, height: 480, background: 'rgba(255,255,255,0.06)', flexShrink: 0 }} />
        )}

        {/* Right: active channel detail */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <h3
              style={{
                fontSize: mobile ? 24 : 34,
                fontWeight: 600,
                color: 'rgba(255,255,255,0.92)',
                letterSpacing: '-0.025em',
              }}
            >
              {active.name}
            </h3>
            <span style={{ fontSize: 14, color: 'rgba(255,255,255,0.3)' }}>{active.label}</span>
          </div>

          <p
            style={{
              fontSize: mobile ? 14 : 16,
              lineHeight: 1.7,
              color: 'rgba(255,255,255,0.45)',
              fontWeight: 300,
            }}
          >
            {active.description}
          </p>

          {/* Product screenshots */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: mobile ? 'flex-start' : 'center',
              gap: mobile ? 12 : 24,
              ...(mobile ? { overflowX: 'auto', paddingBottom: 4 } : {}),
            }}
          >
            {active.shots.map((shot, i) => (
              shot.frame === 'desktop' ? (
                <DesktopFrame key={`${active.id}-${i}`} mobile={mobile}>
                  <ZoomableImage
                    src={shot.src}
                    alt={shot.alt}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      objectPosition: 'top',
                    }}
                  />
                </DesktopFrame>
              ) : (
                <PhoneFrame key={`${active.id}-${i}`} mobile={mobile}>
                  <ZoomableImage
                    src={shot.src}
                    alt={shot.alt}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      objectPosition: 'top',
                    }}
                  />
                </PhoneFrame>
              )
            ))}
          </div>

          {/* Feature bullets */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: mobile ? '1fr' : '1fr 1fr',
              gap: mobile ? 8 : 12,
            }}
          >
            {active.features.map((feature, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: mobile ? 10 : 14,
                  padding: mobile ? '12px 14px' : '14px 20px',
                  borderRadius: mobile ? 10 : 14,
                  background: 'rgba(255,255,255,0.025)',
                  border: '1px solid rgba(255,255,255,0.04)',
                }}
              >
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    backgroundColor: active.accent,
                    opacity: 0.5,
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    fontSize: mobile ? 13 : 14,
                    color: 'rgba(255,255,255,0.5)',
                    lineHeight: 1.5,
                  }}
                >
                  {feature}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

function DesktopFrame({ children, mobile }: { children: React.ReactNode; mobile?: boolean }) {
  return (
    <div
      style={{
        width: mobile ? 200 : 500,
        height: mobile ? 129 : 322,
        borderRadius: mobile ? 12 : 18,
        overflow: 'hidden',
        background: '#050505',
        border: '1px solid rgba(255,255,255,0.1)',
        boxShadow: '0 40px 80px rgba(0,0,0,0.42), 0 0 0 1px rgba(255,255,255,0.04)',
        flexShrink: 0,
      }}
    >
      {children}
    </div>
  )
}

function PhoneFrame({ children, mobile }: { children: React.ReactNode; mobile?: boolean }) {
  return (
    <div
      style={{
        width: mobile ? 128 : 210,
        height: mobile ? 256 : 420,
        borderRadius: mobile ? 20 : 28,
        overflow: 'hidden',
        background: '#000',
        border: '1px solid rgba(255,255,255,0.1)',
        boxShadow: '0 40px 80px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04)',
        flexShrink: 0,
      }}
    >
      {children}
    </div>
  )
}

function ChannelIcon({ id, color }: { id: Channel['id']; color: string }) {
  if (id === 'web-app') {
    return (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ transition: 'stroke 0.4s' }}
      >
        <rect x="3" y="5" width="18" height="12" rx="2" />
        <path d="M8 21h8" />
        <path d="M12 17v4" />
      </svg>
    )
  }
  if (id === 'android') {
    return (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ transition: 'stroke 0.4s' }}
      >
        <rect x="7" y="2" width="10" height="20" rx="2.5" />
        <line x1="12" y1="18" x2="12.01" y2="18" />
      </svg>
    )
  }
  if (id === 'telegram') {
    return (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ transition: 'stroke 0.4s' }}
      >
        <path d="M22 2L11 13" />
        <path d="M22 2l-7 20-4-9-9-4 20-7z" />
      </svg>
    )
  }
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transition: 'stroke 0.4s' }}
    >
      <rect x="3" y="10" width="6" height="4" rx="1" />
      <rect x="15" y="10" width="6" height="4" rx="1" />
      <rect x="10" y="3" width="4" height="6" rx="1" />
      <rect x="10" y="15" width="4" height="6" rx="1" />
    </svg>
  )
}
