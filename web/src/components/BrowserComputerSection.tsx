import { SectionShell } from './SectionShell'
import { Reveal } from './Reveal'
import { Eyebrow, SectionTitle, Lead, FeatureList } from './SectionType'
import { useIsMobile } from '../hooks/useIsMobile'

const ACCENT = '#06b6d4'

const FEATURES = [
  {
    title: 'In-app Browser',
    desc: 'A browser panel next to your chat. Agents navigate, click, type, and screenshot it, including your localhost dev server. You can pin comments on elements and send them back as context.',
  },
  {
    title: 'Chrome Extension',
    desc: 'Drive your own Chrome, with your real logins, cookies, and history. Agents can claim a tab you already have open instead of starting from a signed-out session.',
  },
  {
    title: 'Computer Use',
    desc: 'Read and operate native Mac app UI through the accessibility tree. Clicks land in background windows, so an agent can work while you keep using your machine.',
  },
]

export function BrowserComputerSection() {
  const mobile = useIsMobile()

  return (
    <SectionShell id="automation" accent={ACCENT} glow="center" maxWidth={1180}>
      <Reveal>
        <div style={{ maxWidth: 720 }}>
          <Eyebrow>Browser &amp; Computer Use</Eyebrow>
          <SectionTitle>
            Your agents
            <br />
            <span style={{ color: 'rgba(6,182,212,0.8)' }}>have hands.</span>
          </SectionTitle>
          <Lead>
            Not just a browser panel to look at. Operon agents drive an in-app browser, your real
            Chrome, and native Mac apps, clicking, typing, and checking their own work.
          </Lead>
        </div>

        {!mobile && (
          <div style={{ marginTop: 8 }}>
            <AutomationMock />
          </div>
        )}

        <div style={{ maxWidth: 980, marginTop: mobile ? 4 : 34 }}>
          <FeatureList items={FEATURES} accent={ACCENT} columns={2} />
        </div>
      </Reveal>
    </SectionShell>
  )
}

/* ===== Mock: agent driving a browser / computer target ===== */

const TARGETS = [
  { id: 'iab', label: 'In-app Browser', icon: <GlobeIcon /> },
  { id: 'chrome', label: 'Your Chrome', icon: <BoltIcon /> },
  { id: 'mac', label: 'Mac Apps', icon: <WindowIcon /> },
]

const STEPS: { call: string; result: string; state: 'done' | 'active' }[] = [
  { call: "iab.navigate('localhost:3000/checkout')", result: 'loaded in 240ms', state: 'done' },
  { call: "iab.snapshot()", result: '38 interactive elements', state: 'done' },
  { call: "iab.click({ ref: 'Place order' })", result: 'navigated → /confirm', state: 'done' },
  { call: "iab.screenshot()", result: 'running…', state: 'active' },
]

function AutomationMock() {
  const activeTarget = TARGETS[0]

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
        <div
          style={{
            flex: 1,
            textAlign: 'center',
            fontSize: 12,
            color: 'rgba(255,255,255,0.25)',
            fontWeight: 500,
          }}
        >
          Agent Session
        </div>
      </div>

      {/* Target switcher */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          padding: '14px 20px',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
        }}
      >
        {TARGETS.map((target) => {
          const isActive = target.id === activeTarget.id
          return (
            <div
              key={target.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 14px',
                borderRadius: 10,
                fontSize: 12.5,
                fontWeight: 500,
                background: isActive ? 'rgba(6,182,212,0.08)' : 'rgba(255,255,255,0.02)',
                border: `1px solid ${isActive ? 'rgba(6,182,212,0.22)' : 'rgba(255,255,255,0.04)'}`,
                color: isActive ? 'rgba(6,182,212,0.85)' : 'rgba(255,255,255,0.3)',
              }}
            >
              {target.icon}
              {target.label}
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', height: 440 }}>
        {/* Left: agent tool calls */}
        <div
          style={{
            width: 290,
            flexShrink: 0,
            borderRight: '1px solid rgba(255,255,255,0.05)',
            padding: 18,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div
            style={{
              fontSize: 11,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'rgba(255,255,255,0.22)',
              fontWeight: 500,
              marginBottom: 2,
            }}
          >
            Tool calls
          </div>

          {STEPS.map((step, i) => {
            const isActive = step.state === 'active'
            return (
              <div
                key={i}
                style={{
                  padding: '11px 13px',
                  borderRadius: 11,
                  background: isActive ? 'rgba(6,182,212,0.05)' : 'rgba(255,255,255,0.025)',
                  border: `1px solid ${isActive ? 'rgba(6,182,212,0.12)' : 'rgba(255,255,255,0.04)'}`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  {isActive ? (
                    <SpinnerIcon />
                  ) : (
                    <CheckIcon />
                  )}
                  <code
                    style={{
                      fontSize: 11.5,
                      fontFamily: 'monospace',
                      lineHeight: 1.55,
                      color: 'rgba(255,255,255,0.62)',
                      wordBreak: 'break-word',
                    }}
                  >
                    {step.call}
                  </code>
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: isActive ? 'rgba(6,182,212,0.5)' : 'rgba(255,255,255,0.25)',
                    marginTop: 6,
                    marginLeft: 22,
                  }}
                >
                  {step.result}
                </div>
              </div>
            )
          })}

          <div
            style={{
              marginTop: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '11px 13px',
              borderRadius: 11,
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid rgba(255,255,255,0.04)',
            }}
          >
            <EyeIcon />
            <span style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.3)', lineHeight: 1.5 }}>
              You watch every step, live
            </span>
          </div>
        </div>

        {/* Right: the page being driven */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {/* Address bar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '12px 16px',
              borderBottom: '1px solid rgba(255,255,255,0.05)',
            }}
          >
            <div style={{ display: 'flex', gap: 6, color: 'rgba(255,255,255,0.18)' }}>
              <ChevronLeftIcon />
              <ChevronRightIcon />
            </div>
            <div
              style={{
                flex: 1,
                padding: '7px 12px',
                borderRadius: 9,
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.05)',
                fontSize: 11.5,
                fontFamily: 'monospace',
                color: 'rgba(255,255,255,0.35)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              localhost:3000/checkout
            </div>
            <div
              style={{
                padding: '4px 9px',
                borderRadius: 7,
                fontSize: 10.5,
                fontWeight: 500,
                background: 'rgba(6,182,212,0.08)',
                border: '1px solid rgba(6,182,212,0.18)',
                color: 'rgba(6,182,212,0.7)',
                whiteSpace: 'nowrap',
              }}
            >
              Agent driving
            </div>
          </div>

          {/* Page content */}
          <div style={{ flex: 1, padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div
              style={{
                fontSize: 15,
                fontWeight: 600,
                color: 'rgba(255,255,255,0.72)',
              }}
            >
              Checkout
            </div>

            {/* Fake form rows */}
            {['Email', 'Card number'].map((label) => (
              <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.28)' }}>{label}</span>
                <div
                  style={{
                    height: 32,
                    borderRadius: 9,
                    background: 'rgba(255,255,255,0.025)',
                    border: '1px solid rgba(255,255,255,0.05)',
                  }}
                />
              </div>
            ))}

            {/* Targeted button with cursor */}
            <div style={{ position: 'relative', marginTop: 4 }}>
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '10px 22px',
                  borderRadius: 10,
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: 'rgba(6,182,212,0.9)',
                  background: 'rgba(6,182,212,0.1)',
                  border: '1px solid rgba(6,182,212,0.35)',
                  boxShadow: '0 0 0 4px rgba(6,182,212,0.07)',
                }}
              >
                Place order
              </div>
              <div style={{ position: 'absolute', left: 80, top: 19, color: 'rgba(6,182,212,0.8)' }}>
                <CursorIcon />
              </div>
            </div>

            {/* Annotation pin */}
            <div
              style={{
                marginTop: 'auto',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: '13px 15px',
                borderRadius: 12,
                background: 'rgba(255,255,255,0.025)',
                border: '1px solid rgba(255,255,255,0.05)',
              }}
            >
              <div
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                  fontWeight: 600,
                  color: 'rgba(6,182,212,0.9)',
                  background: 'rgba(6,182,212,0.12)',
                  border: '1px solid rgba(6,182,212,0.3)',
                }}
              >
                1
              </div>
              <div>
                <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.5)', lineHeight: 1.6 }}>
                  &ldquo;This button should stay disabled until the card field validates.&rdquo;
                </div>
                <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.22)', marginTop: 5 }}>
                  Pinned by you · sent to the agent with the element and its styles
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ===== Icons ===== */

function GlobeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 0 20a15.3 15.3 0 0 1 0-20z" />
    </svg>
  )
}

function BoltIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  )
}

function WindowIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M2 9h20" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function SpinnerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(6,182,212,0.7)" strokeWidth="2.4" strokeLinecap="round" style={{ flexShrink: 0, marginTop: 2 }}>
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}

function EyeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function ChevronLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  )
}

function ChevronRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

function CursorIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="rgba(13,17,23,0.9)" strokeWidth="1.2" strokeLinejoin="round">
      <path d="M5 3l14 8-6.5 1.5L9 19z" />
    </svg>
  )
}
