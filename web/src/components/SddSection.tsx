import { useIsMobile } from '../hooks/useIsMobile'
import { useIsCompactViewport } from '../hooks/useIsCompactViewport'
import { ZoomableImage } from './ImageZoom'
import specImg from '../assets/spec.png'

const ACCENT = '#0ea5e9'

const FEATURES = [
  {
    title: 'Approval gates',
    desc: 'Spec, plan, and acceptance each get a human sign-off before work moves on. Nobody starts coding before the design is approved.',
  },
  {
    title: 'Change packages in git',
    desc: 'spec.md, plan.md, and acceptance.md live on a branch under .operon/ — the design lands in the same diff as the code, not in a database row.',
  },
  {
    title: 'Decompose & dispatch',
    desc: 'A large change splits into child tasks, each on its own branch, executed by the agent best suited for it — fresh agents inherit context by reading the spec.',
  },
  {
    title: 'Sediments back',
    desc: 'When a change ships, its spec folds into a project-level living specification, so the next change starts from the current truth.',
  },
]

export function SddSection() {
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
          width: 900,
          height: 900,
          borderRadius: '50%',
          top: '50%',
          right: '-5%',
          transform: 'translateY(-50%)',
          background: 'radial-gradient(circle, rgba(14,165,233,0.10) 0%, transparent 70%)',
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 500,
          height: 500,
          borderRadius: '50%',
          top: '15%',
          left: '10%',
          background: 'radial-gradient(circle, rgba(99,102,241,0.05) 0%, transparent 70%)',
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
        <div style={{ width: mobile ? '100%' : 540, flexShrink: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginBottom: mobile ? 10 : 16,
            }}
          >
            <p
              style={{
                fontSize: 12,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'rgba(255,255,255,0.3)',
                fontWeight: 500,
              }}
            >
              Spec-Driven Development
            </p>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '2px 8px',
                borderRadius: 6,
                background: 'rgba(14,165,233,0.08)',
                border: '1px solid rgba(14,165,233,0.18)',
              }}
            >
              <div
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  backgroundColor: ACCENT,
                  opacity: 0.85,
                }}
              />
              <span
                style={{
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  color: 'rgba(125,211,252,0.85)',
                  fontWeight: 500,
                }}
              >
                New
              </span>
            </span>
          </div>

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
            Align first.
            <br />
            <span style={{ color: `${ACCENT}cc` }}>Then build.</span>
          </h2>

          <p
            style={{
              fontSize: mobile ? 14 : 17,
              lineHeight: mobile ? 1.75 : 1.62,
              color: 'rgba(255,255,255,0.4)',
              fontWeight: 300,
              marginBottom: mobile ? 20 : 28,
            }}
          >
            SDD turns a one-line task into a reviewable change package — a
            written spec, a technical plan, and acceptance criteria, with
            approval gates between each stage. It pulls agents out of vibe
            coding into a controlled loop. Opt-in per channel; everything
            else works exactly as before.
          </p>

          {/* Feature list */}
          <div
            style={{
              display: mobile ? 'flex' : 'grid',
              ...(mobile
                ? { flexDirection: 'column', gap: 14 }
                : { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', columnGap: 22, rowGap: 16 }),
            }}
          >
            {FEATURES.map((item, i) => (
              <div key={i} style={{ display: 'flex', gap: mobile ? 10 : 10 }}>
                <div
                  style={{
                    width: mobile ? 8 : 6,
                    height: mobile ? 8 : 6,
                    borderRadius: '50%',
                    backgroundColor: ACCENT,
                    opacity: 0.6,
                    marginTop: mobile ? 8 : 7,
                    flexShrink: 0,
                  }}
                />
                <div>
                  <div
                    style={{
                      fontSize: mobile ? 14 : 14,
                      fontWeight: 500,
                      color: 'rgba(255,255,255,0.82)',
                      marginBottom: mobile ? 4 : 3,
                    }}
                  >
                    {item.title}
                  </div>
                  <div
                    style={{
                      fontSize: mobile ? 12 : 13,
                      lineHeight: mobile ? 1.6 : 1.45,
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

        {/* Right: screenshot */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            ...(mobile ? {} : { marginRight: -40 }),
          }}
        >
          <div
            style={{
              width: mobile ? '100%' : 'calc(100% + 40px)',
              aspectRatio: '2800 / 1800',
              overflow: 'hidden',
              border: '1px solid rgba(255,255,255,0.08)',
              boxShadow: '0 40px 110px rgba(0,0,0,0.52)',
              background: 'rgba(255,255,255,0.035)',
              borderRadius: mobile ? 14 : 20,
            }}
          >
            <ZoomableImage
              src={specImg}
              alt="Operon SDD change package with spec, plan, and acceptance approval gates"
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                display: 'block',
              }}
            />
          </div>
        </div>
      </div>
    </section>
  )
}
