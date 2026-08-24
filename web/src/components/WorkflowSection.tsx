import { useIsMobile } from '../hooks/useIsMobile'
import { useIsCompactViewport } from '../hooks/useIsCompactViewport'
import { ZoomableImage } from './ImageZoom'
import workflowImg from '../assets/workflow.png'

export function WorkflowSection() {
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
          background: 'radial-gradient(circle, rgba(99,102,241,0.08) 0%, transparent 70%)',
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 500,
          height: 500,
          borderRadius: '50%',
          bottom: '10%',
          left: '10%',
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
        {/* ===== Left: text content ===== */}
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
            Canvas Workflow
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
            Build AI
            <br />
            pipelines,
            <br />
            <span style={{ color: 'rgba(139,92,246,0.7)' }}>visually.</span>
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
            Chain multiple AI models together on a visual canvas.
            Orchestrate multi-turn conversations within a single session,
            connect nodes, pass context between steps, and run
            entire workflows with one click.
          </p>

          {/* Feature list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: mobile ? 14 : 20 }}>
            {[
              {
                title: 'DAG Execution Engine',
                desc: 'True parallel execution — downstream nodes start the moment their inputs are ready.',
              },
              {
                title: 'Template Variables',
                desc: 'Reference any upstream output with {{nodeName}} syntax for flexible data flow.',
              },
              {
                title: 'Multi-Turn Orchestration',
                desc: 'Arrange multiple conversation turns within one session for complex, sequential tasks.',
              },
              {
                title: 'Scheduled Runs',
                desc: 'Set workflows on a cron schedule for automated, recurring execution.',
              },
            ].map((item, i) => (
              <div key={i} style={{ display: 'flex', gap: mobile ? 10 : 16 }}>
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    backgroundColor: '#8b5cf6',
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

        {/* ===== Right: workflow screenshot ===== */}
        <div style={{ flex: 1, minWidth: 0, marginRight: mobile ? 0 : -60 }}>
          <div
            style={{
              width: mobile ? '100%' : 'calc(100% + 60px)',
              borderRadius: mobile ? 12 : 20,
              overflow: 'hidden',
              border: '1px solid rgba(255,255,255,0.06)',
              boxShadow: '0 40px 100px rgba(0,0,0,0.5)',
            }}
          >
            <ZoomableImage
              src={workflowImg}
              alt="Canvas Workflow"
              style={{
                width: '100%',
                display: 'block',
              }}
            />
          </div>
        </div>
      </div>
    </section>
  )
}
