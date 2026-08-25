import { SectionShell } from './SectionShell'
import { Reveal } from './Reveal'
import { SectionTitle } from './SectionType'
import { useIsMobile } from '../hooks/useIsMobile'

const FEATURES = [
  {
    icon: <ClockIcon />,
    title: 'Scheduled Tasks',
    description:
      'Set up cron jobs to run AI prompts or entire workflows on a schedule. Daily, weekly, or interval-based, fully automated.',
    color: '#f59e0b',
  },
  {
    icon: <SendIcon />,
    title: 'Send to Agent',
    description:
      'Forward any message to a different model or chat tab with one click. Compare answers or delegate follow-ups instantly.',
    color: '#3b82f6',
  },
  {
    icon: <CodeSendIcon />,
    title: 'Code to Chat',
    description:
      'Select code in the file preview and send it directly to any open agent tab. Includes file path and line numbers as context.',
    color: '#10b981',
  },
  {
    icon: <SkillIcon />,
    title: 'Skills',
    description:
      'Pluggable instruction packs that extend agent capabilities. Install from GitHub or create your own. They load on demand.',
    color: '#8b5cf6',
  },
  {
    icon: <ServerIcon />,
    title: 'Context Window',
    description:
      'Visualize context window usage in real time. Track token consumption and remaining capacity during conversations.',
    color: '#ec4899',
  },
  {
    icon: <ShieldIcon />,
    title: 'Permission Control',
    description:
      'Fine-grained approval gates for file writes, command execution, and destructive actions. You stay in control.',
    color: '#06b6d4',
  },
]

const FEATURE_SPANS = [5, 3, 4, 4, 5, 3] as const

export function FeaturesSection() {
  const mobile = useIsMobile()

  return (
    <SectionShell id="more" accent="#6366f1" glow="center" maxWidth={1280}>
      <Reveal>
        <div style={{ textAlign: 'center', marginBottom: mobile ? 34 : 54 }}>
          <SectionTitle align="center">
            Small things.
            <br />
            <span style={{ color: 'rgba(255,255,255,0.38)' }}>Big difference.</span>
          </SectionTitle>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: mobile ? '1fr' : 'repeat(12, minmax(0, 1fr))',
            gap: mobile ? 12 : 18,
          }}
        >
          {FEATURES.map((feature, i) => (
            <div
              key={feature.title}
              style={{
                height: '100%',
                gridColumn: mobile ? undefined : `span ${FEATURE_SPANS[i]}`,
                padding: mobile ? '20px 18px' : '30px 28px',
                borderRadius: 18,
                background: `linear-gradient(135deg, ${feature.color}0d, rgba(13,17,23,0.78) 48%)`,
                border: `1px solid ${feature.color}18`,
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              <div
                aria-hidden
                style={{
                  position: 'absolute',
                  top: -40,
                  right: -40,
                  width: 120,
                  height: 120,
                  borderRadius: '50%',
                  background: feature.color,
                  opacity: 0.05,
                  filter: 'blur(40px)',
                  pointerEvents: 'none',
                }}
              />

              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 13,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: `${feature.color}12`,
                  border: `1px solid ${feature.color}20`,
                  marginBottom: mobile ? 16 : 22,
                  color: feature.color,
                }}
              >
                {feature.icon}
              </div>

              <h3
                style={{
                  fontSize: mobile ? 17 : 19,
                  fontWeight: 600,
                  color: 'rgba(255,255,255,0.88)',
                  marginBottom: 10,
                  letterSpacing: '-0.01em',
                }}
              >
                {feature.title}
              </h3>

              <p
                style={{
                  fontSize: mobile ? 13.5 : 14.5,
                  lineHeight: 1.68,
                  color: 'rgba(255,255,255,0.38)',
                  fontWeight: 300,
                }}
              >
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </Reveal>
    </SectionShell>
  )
}

/* ===== Icons ===== */

function ClockIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 14l-4-4 4-4" />
      <path d="M5 10h11a4 4 0 0 1 0 8h-1" />
    </svg>
  )
}

function CodeSendIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  )
}

function SkillIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  )
}

function ServerIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="8" rx="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" />
      <circle cx="6" cy="6" r="1" fill="currentColor" />
      <circle cx="6" cy="18" r="1" fill="currentColor" />
    </svg>
  )
}

function ShieldIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  )
}
