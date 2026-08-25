import { SectionShell } from './SectionShell'
import { Reveal } from './Reveal'
import { SectionTitle, Lead, FeatureList, SplitLayout } from './SectionType'
import { useIsMobile } from '../hooks/useIsMobile'

const ACCENT = '#ec4899'

const FEATURES = [
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
]

export function MemorySection() {
  const mobile = useIsMobile()

  return (
    <SectionShell id="memory" accent={ACCENT} glow="left">
      <SplitLayout
        copyWidth={430}
        copy={
          <Reveal>
            <SectionTitle>
              Every conversation
              <br />
              <span style={{ color: 'rgba(236,72,153,0.8)' }}>builds on the last.</span>
            </SectionTitle>
            <Lead>
              A persistent, semantic memory system that learns from every conversation. Preferences,
              patterns, and context, always available.
            </Lead>
            <FeatureList items={FEATURES} accent={ACCENT} />
          </Reveal>
        }
        visual={
          mobile ? null : (
            <Reveal delay={45}>
              <MemoryMock />
            </Reveal>
          )
        }
      />
    </SectionShell>
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
    { name: 'Entities', color: '#ec4899', count: 9, memories: [] },
    { name: 'Events', color: '#06b6d4', count: 4, memories: [] },
  ]

  const selectedCat = categories[1] // Preferences selected

  return (
    <div
      style={{
        width: '100%',
        borderRadius: 18,
        overflow: 'hidden',
        background: '#0d1117',
        border: '1px solid rgba(255,255,255,0.06)',
        boxShadow: '0 30px 80px rgba(0,0,0,0.45)',
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

      <div style={{ display: 'flex', height: 440 }}>
        {/* Left: category list */}
        <div
          style={{
            width: 190,
            flexShrink: 0,
            borderRight: '1px solid rgba(255,255,255,0.05)',
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
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
        <div style={{ flex: 1, minWidth: 0, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
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
            <span style={{ fontSize: 15, fontWeight: 500, color: 'rgba(255,255,255,0.8)' }}>
              {selectedCat.name}
            </span>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.25)', marginLeft: 4 }}>
              {selectedCat.count} memories
            </span>
          </div>

          {selectedCat.memories.map((mem) => (
            <div
              key={mem.title}
              style={{
                padding: '16px 18px',
                borderRadius: 13,
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

          <div
            style={{
              marginTop: 'auto',
              padding: '16px 18px',
              borderRadius: 13,
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
              {['0.847', '0.234', '-0.591', '0.103', '0.672', '-0.338', '0.455', '...'].map((v) => (
                <span
                  key={v}
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
