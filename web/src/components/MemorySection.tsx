import { useIsMobile } from '../hooks/useIsMobile'
import { useIsCompactViewport } from '../hooks/useIsCompactViewport'

export function MemorySection() {
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
      {/* Background */}
      <div
        style={{
          position: 'absolute',
          width: 800,
          height: 800,
          borderRadius: '50%',
          top: '40%',
          left: '20%',
          transform: 'translate(-50%, -50%)',
          background: 'radial-gradient(circle, rgba(236,72,153,0.05) 0%, transparent 70%)',
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 600,
          height: 600,
          borderRadius: '50%',
          bottom: '10%',
          right: '10%',
          background: 'radial-gradient(circle, rgba(168,85,247,0.04) 0%, transparent 70%)',
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
            Memory
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
            Every conversation
            <br />
            <span style={{ color: 'rgba(236,72,153,0.7)' }}>builds on the last.</span>
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
            A persistent, semantic memory system that learns from every
            conversation. Preferences, patterns, and context — always
            available.
          </p>
          {/* Feature list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: mobile ? 14 : 20 }}>
            {[
              {
                title: 'Auto Extraction',
                desc: 'The AI proactively learns and stores valuable information from conversations.',
              },
              {
                title: 'Semantic Search',
                desc: 'Find memories by meaning with vector embeddings, not keyword matching.',
              },
              {
                title: 'Smart Deduplication',
                desc: 'Vector similarity prevents duplicate memories without needing an LLM call.',
              },
              {
                title: 'Context Injection',
                desc: 'Profile and preferences are automatically included in every conversation.',
              },
            ].map((item, i) => (
              <div key={i} style={{ display: 'flex', gap: mobile ? 10 : 16 }}>
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    backgroundColor: '#ec4899',
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

        {/* Right: memory UI mock */}
        {!mobile && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <MemoryMock />
          </div>
        )}
      </div>
    </section>
  )
}

/* ===== Mock memory management UI ===== */
function MemoryMock() {
  const categories: {
    name: string
    color: string
    count: number
    memories: { title: string; preview: string; time: string }[]
  }[] = [
    {
      name: 'Profile',
      color: '#3b82f6',
      count: 3,
      memories: [
        { title: 'Role & Background', preview: 'Senior full-stack engineer, 5 years with TypeScript and React...', time: '2d ago' },
        { title: 'Team Context', preview: 'Works on the platform team, responsible for developer tooling...', time: '5d ago' },
      ],
    },
    {
      name: 'Preferences',
      color: '#10b981',
      count: 7,
      memories: [
        { title: 'Code Style', preview: 'Prefers functional components, avoids class-based React. Uses pnpm...', time: '1d ago' },
        { title: 'Communication', preview: 'Prefers concise responses, no trailing summaries. English only...', time: '3d ago' },
      ],
    },
    {
      name: 'Cases',
      color: '#f59e0b',
      count: 12,
      memories: [
        { title: 'Auth Migration Fix', preview: 'Problem: JWT tokens not refreshing after migration. Solution: updated...', time: '1w ago' },
      ],
    },
    {
      name: 'Patterns',
      color: '#8b5cf6',
      count: 5,
      memories: [
        { title: 'DAG Execution', preview: 'Use Promise.race for wait-for-any, not Promise.all for batch waiting...', time: '2w ago' },
      ],
    },
    {
      name: 'Entities',
      color: '#ec4899',
      count: 9,
      memories: [],
    },
    {
      name: 'Events',
      color: '#06b6d4',
      count: 4,
      memories: [],
    },
  ]

  const selectedCat = categories[1] // Preferences selected

  return (
    <div
      style={{
        width: '100%',
        borderRadius: 20,
        overflow: 'hidden',
        background: '#0d1117',
        border: '1px solid rgba(255,255,255,0.06)',
        boxShadow: '0 40px 100px rgba(0,0,0,0.5)',
      }}
    >
      {/* Title bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '14px 20px',
          background: '#161b22',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
        }}
      >
        <div style={{ display: 'flex', gap: 6 }}>
          <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#ff5f57' }} />
          <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#febc2e' }} />
          <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#28c840' }} />
        </div>
        <div style={{ flex: 1, textAlign: 'center', fontSize: 12, color: 'rgba(255,255,255,0.25)', fontWeight: 500 }}>
          Memory
        </div>
      </div>

      <div style={{ display: 'flex', height: 480 }}>
        {/* Left: category list */}
        <div
          style={{
            width: 200,
            borderRight: '1px solid rgba(255,255,255,0.05)',
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {/* Search bar */}
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 10,
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.05)',
              fontSize: 12,
              color: 'rgba(255,255,255,0.2)',
              marginBottom: 12,
            }}
          >
            Search memories...
          </div>

          {categories.map((cat) => {
            const isActive = cat.name === selectedCat.name
            return (
              <div
                key={cat.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 12px',
                  borderRadius: 10,
                  background: isActive ? 'rgba(255,255,255,0.05)' : 'transparent',
                  transition: 'background 0.3s',
                }}
              >
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    backgroundColor: cat.color,
                    opacity: isActive ? 0.8 : 0.3,
                  }}
                />
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: isActive ? 500 : 400,
                    color: isActive ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.3)',
                    flex: 1,
                  }}
                >
                  {cat.name}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: isActive ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.15)',
                    fontWeight: 500,
                  }}
                >
                  {cat.count}
                </span>
              </div>
            )
          })}
        </div>

        {/* Right: memory list */}
        <div style={{ flex: 1, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Category header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                backgroundColor: selectedCat.color,
                opacity: 0.7,
              }}
            />
            <span style={{ fontSize: 16, fontWeight: 500, color: 'rgba(255,255,255,0.8)' }}>
              {selectedCat.name}
            </span>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.25)', marginLeft: 4 }}>
              {selectedCat.count} memories
            </span>
          </div>

          {/* Memory cards */}
          {selectedCat.memories.map((mem, i) => (
            <div
              key={i}
              style={{
                padding: '18px 20px',
                borderRadius: 14,
                background: 'rgba(255,255,255,0.025)',
                border: '1px solid rgba(255,255,255,0.04)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 500, color: 'rgba(255,255,255,0.75)' }}>
                  {mem.title}
                </span>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>{mem.time}</span>
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.6, color: 'rgba(255,255,255,0.35)' }}>
                {mem.preview}
              </div>
            </div>
          ))}

          {/* Embedding visualization */}
          <div
            style={{
              marginTop: 'auto',
              padding: '16px 20px',
              borderRadius: 14,
              background: 'rgba(236,72,153,0.04)',
              border: '1px solid rgba(236,72,153,0.08)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <circle cx="7" cy="7" r="6" stroke="rgba(236,72,153,0.4)" strokeWidth="1" />
                <circle cx="5" cy="6" r="1.5" fill="rgba(236,72,153,0.5)" />
                <circle cx="9" cy="5" r="1" fill="rgba(168,85,247,0.5)" />
                <circle cx="8" cy="9" r="1.2" fill="rgba(99,102,241,0.5)" />
              </svg>
              <span style={{ fontSize: 12, fontWeight: 500, color: 'rgba(236,72,153,0.6)' }}>
                Vector Embeddings
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {['0.847', '0.234', '-0.591', '0.103', '0.672', '-0.338', '0.455', '...'].map((v, i) => (
                <span
                  key={i}
                  style={{
                    fontSize: 11,
                    fontFamily: 'monospace',
                    padding: '3px 8px',
                    borderRadius: 6,
                    background: 'rgba(255,255,255,0.03)',
                    color: 'rgba(255,255,255,0.3)',
                  }}
                >
                  {v}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
