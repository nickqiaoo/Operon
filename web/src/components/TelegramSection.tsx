import { useIsMobile } from '../hooks/useIsMobile'
import { useIsCompactViewport } from '../hooks/useIsCompactViewport'
import { ZoomableImage } from './ImageZoom'
import tgImg from '../assets/tg.PNG'
import tgDiffImg from '../assets/tgdiff.PNG'

export function TelegramSection() {
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
          background: 'radial-gradient(circle, rgba(56,163,224,0.06) 0%, transparent 70%)',
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
        {/* Left: text */}
        <div style={{ width: mobile ? '100%' : 420, flexShrink: 0 }}>
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
            Telegram Bot
          </p>
          <h2
            style={{
              fontSize: mobile ? 32 : 52,
              fontWeight: 600,
              color: 'rgba(255,255,255,0.92)',
              lineHeight: 1.1,
              letterSpacing: '-0.025em',
              marginBottom: mobile ? 14 : 24,
            }}
          >
            Code from
            <br />
            <span style={{ color: 'rgba(56,163,224,0.75)' }}>anywhere.</span>
          </h2>

          <p
            style={{
              fontSize: mobile ? 14 : 19,
              lineHeight: 1.75,
              color: 'rgba(255,255,255,0.38)',
              fontWeight: 300,
              marginBottom: mobile ? 20 : 44,
            }}
          >
            Control your coding agent directly from Telegram. Review changes,
            approve permissions, and inspect diffs — all without leaving
            your phone. Seamlessly switch the same session between desktop
            and Telegram at any time.
          </p>

          {/* Feature list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: mobile ? 14 : 20 }}>
            {[
              {
                title: 'Permission Control',
                desc: 'Approve or deny file edits and tool calls with one tap.',
              },
              {
                title: 'Inline Diff Viewer',
                desc: 'View syntax-highlighted code diffs in a Telegram Mini App. Diff preview requires a separately deployed server-side service.',
              },
              {
                title: 'Cross-Device Session',
                desc: 'Seamlessly continue the same session between desktop and Telegram.',
              },
              {
                title: 'Real-time Streaming',
                desc: 'Watch agent responses stream in real time, just like the desktop app.',
              },
            ].map((item, i) => (
              <div key={i} style={{ display: 'flex', gap: mobile ? 10 : 16 }}>
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    backgroundColor: '#38a3e0',
                    opacity: 0.5,
                    marginTop: 8,
                    flexShrink: 0,
                  }}
                />
                <div>
                  <div
                    style={{
                      fontSize: mobile ? 14 : 16,
                      fontWeight: 500,
                      color: 'rgba(255,255,255,0.8)',
                      marginBottom: 4,
                    }}
                  >
                    {item.title}
                  </div>
                  <div
                    style={{
                      fontSize: mobile ? 12 : 14,
                      lineHeight: 1.6,
                      color: 'rgba(255,255,255,0.35)',
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

        {/* Right: phone screenshots */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            justifyContent: 'center',
            gap: mobile ? 12 : 24,
          }}
        >
          {/* Phone frame 1: Chat */}
          <PhoneFrame mobile={mobile}>
            <ZoomableImage
              src={tgImg}
              alt="Telegram bot chat"
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                objectPosition: 'top',
              }}
            />
          </PhoneFrame>

          {/* Phone frame 2: Diff viewer */}
          <PhoneFrame mobile={mobile}>
            <ZoomableImage
              src={tgDiffImg}
              alt="Telegram diff viewer"
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                objectPosition: 'top',
              }}
            />
          </PhoneFrame>
        </div>
      </div>
    </section>
  )
}

function PhoneFrame({ children, mobile }: { children: React.ReactNode; mobile?: boolean }) {
  return (
    <div
      style={{
        width: mobile ? 150 : 220,
        height: mobile ? 300 : 440,
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
