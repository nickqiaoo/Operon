import { useIsMobile } from '../hooks/useIsMobile'
import { useIsCompactViewport } from '../hooks/useIsCompactViewport'
import { ZoomableImage } from './ImageZoom'
import external1 from '../assets/external1.png'
import external2 from '../assets/external2.png'

export function ExternalAgentSection() {
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
      {/* Background glows */}
      <div
        style={{
          position: 'absolute',
          width: 800,
          height: 800,
          borderRadius: '50%',
          top: '40%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'radial-gradient(circle, rgba(99,102,241,0.06) 0%, transparent 70%)',
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
        {/* Left: text content */}
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
            External Agent
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
            One plans. One builds.
            <br />
            <span style={{ color: 'rgba(99,102,241,0.7)' }}>One reviews.</span>
          </h2>
          <p
            style={{
              fontSize: mobile ? 14 : 19,
              lineHeight: 1.7,
              color: 'rgba(255,255,255,0.35)',
              fontWeight: 300,
              marginBottom: mobile ? 20 : 48,
            }}
          >
            Orchestrate agents with natural language. Claude Code plans,
            Codex executes, Gemini reviews — delegate tasks across agents
            in real-time from a single conversation.
          </p>

          {/* Feature highlights */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: mobile ? 14 : 20 }}>
            {[
              {
                label: 'Async Execution',
                desc: 'Child agents run in background tabs without blocking the main conversation.',
                color: '#d97706',
              },
              {
                label: 'Natural Language Orchestration',
                desc: 'Describe your multi-agent pipeline in plain text — no code or config required.',
                color: '#10b981',
              },
              {
                label: 'Cross-Agent Context',
                desc: 'Message-based notification mechanism for seamless inter-agent communication.',
                color: '#6366f1',
              },
            ].map((item, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: mobile ? 10 : 14 }}>
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    backgroundColor: item.color,
                    opacity: 0.6,
                    marginTop: 7,
                    flexShrink: 0,
                  }}
                />
                <div>
                  <div
                    style={{
                      fontSize: mobile ? 13 : 15,
                      fontWeight: 500,
                      color: 'rgba(255,255,255,0.7)',
                      marginBottom: 4,
                    }}
                  >
                    {item.label}
                  </div>
                  <div
                    style={{
                      fontSize: mobile ? 12 : 13,
                      lineHeight: 1.6,
                      color: 'rgba(255,255,255,0.3)',
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

        {/* Divider */}
        {!mobile && (
          <div
            style={{
              width: 1,
              height: 480,
              background: 'rgba(255,255,255,0.06)',
              flexShrink: 0,
            }}
          />
        )}

        {/* Right: screenshots stacked with offset */}
        <div
          style={mobile ? {
            flex: 1,
            minWidth: 0,
            position: 'relative',
            height: 280,
          } : {
            flex: 1,
            minWidth: 0,
            position: 'relative',
            height: 580,
          }}
        >
          {/* Screenshot 2 - Review (back layer) */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: mobile ? 0 : -30,
              width: mobile ? '80%' : '88%',
              borderRadius: mobile ? 10 : 16,
              overflow: 'hidden',
              border: '1px solid rgba(255,255,255,0.08)',
              boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
              zIndex: 1,
            }}
          >
            <ZoomableImage
              src={external2}
              alt="Gemini reviewing the implementation and finding issues"
              style={{ width: '100%', display: 'block' }}
            />
          </div>

          {/* Screenshot 1 - Plan & Execute (front layer) */}
          <div
            style={{
              position: 'absolute',
              bottom: 0,
              right: mobile ? 0 : -30,
              width: mobile ? '80%' : '88%',
              borderRadius: mobile ? 10 : 16,
              overflow: 'hidden',
              border: '1px solid rgba(255,255,255,0.08)',
              boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
              zIndex: 2,
            }}
          >
            <ZoomableImage
              src={external1}
              alt="Claude Code planning and Codex executing a feature"
              style={{ width: '100%', display: 'block' }}
            />
          </div>
        </div>
      </div>
    </section>
  )
}
