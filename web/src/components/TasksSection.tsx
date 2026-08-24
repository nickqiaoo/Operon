import { useIsMobile } from '../hooks/useIsMobile'
import { useIsCompactViewport } from '../hooks/useIsCompactViewport'
import { ZoomableImage } from './ImageZoom'
import taskImg from '../assets/task.png'

const ACCENT = '#22c55e'

const FEATURES = [
  {
    title: 'Kanban board',
    desc: 'Plan work in columns, drag tasks across status, and keep every agent job visible.',
  },
  {
    title: 'Agent Teams',
    desc: 'Group related tasks so agents coordinate through a shared team inbox instead of scattered chat.',
  },
  {
    title: 'Branch per task',
    desc: 'Dispatch work into an isolated git worktree, then inspect the exact files the agent changed.',
  },
  {
    title: 'Live activity',
    desc: 'Comments, status changes, dispatch events, and wakeups stay attached to the task.',
  },
]

export function TasksSection() {
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
      <div
        style={{
          position: 'absolute',
          width: 900,
          height: 900,
          borderRadius: '50%',
          top: '45%',
          left: '-8%',
          transform: 'translateY(-50%)',
          background: 'radial-gradient(circle, rgba(34,197,94,0.09) 0%, transparent 70%)',
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 620,
          height: 620,
          borderRadius: '50%',
          right: '8%',
          bottom: '5%',
          background: 'radial-gradient(circle, rgba(14,165,233,0.06) 0%, transparent 70%)',
          pointerEvents: 'none',
        }}
      />

      <div
        data-scrollable
        style={{
          display: 'flex',
          flexDirection: mobile ? 'column' : 'row',
          alignItems: mobile ? 'stretch' : compactViewport ? 'flex-start' : 'center',
          gap: mobile ? 24 : 72,
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
        <div style={{ width: mobile ? '100%' : 470, flexShrink: 0 }}>
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
            Tasks
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
            Turn decisions into
            <br />
            <span style={{ color: `${ACCENT}cc` }}>tracked work.</span>
          </h2>

          <p
            style={{
              fontSize: mobile ? 14 : 18,
              lineHeight: 1.72,
              color: 'rgba(255,255,255,0.4)',
              fontWeight: 300,
              marginBottom: mobile ? 20 : 34,
            }}
          >
            Tasks gives every project a durable board where humans and agents
            create work, assign owners, dispatch branches, and follow progress
            without losing the thread.
          </p>

          <div
            style={{
              display: mobile ? 'flex' : 'grid',
              ...(mobile
                ? { flexDirection: 'column', gap: 14 }
                : { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', columnGap: 22, rowGap: 18 }),
            }}
          >
            {FEATURES.map((item) => (
              <div key={item.title} style={{ display: 'flex', gap: mobile ? 10 : 10 }}>
                <div
                  style={{
                    width: mobile ? 8 : 6,
                    height: mobile ? 8 : 6,
                    borderRadius: '50%',
                    backgroundColor: ACCENT,
                    opacity: 0.65,
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

        <div
          style={{
            flex: 1,
            minWidth: 0,
            ...(mobile ? {} : { marginRight: -54 }),
          }}
        >
          <div
            style={{
              width: mobile ? '100%' : 'calc(100% + 54px)',
              aspectRatio: '2274 / 1122',
              borderRadius: mobile ? 14 : 20,
              overflow: 'hidden',
              border: '1px solid rgba(255,255,255,0.08)',
              boxShadow: '0 40px 110px rgba(0,0,0,0.52)',
              background: 'rgba(255,255,255,0.035)',
            }}
          >
            <ZoomableImage
              src={taskImg}
              alt="Operon task board with Kanban columns and agent team coordination"
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
