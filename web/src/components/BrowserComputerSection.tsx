import { useState, type ReactNode } from 'react'
import { Reveal } from './Reveal'
import { Eyebrow, FeatureList, Lead, Muted, Section, Title, Window } from './ui'
import { cn } from '../lib/styles'

const FEATURES = [
  {
    title: 'In-app browser',
    desc: 'A browser beside the chat. Agents navigate, click, type and screenshot it — including your localhost dev server — and you can pin comments on elements to send back.',
  },
  {
    title: 'Your Chrome',
    desc: 'Drive your own Chrome with your real logins. Agents can take over a tab you already have open; permissions for both browsers live on one page.',
  },
  {
    title: 'Mac apps',
    desc: 'Computer Use reads and operates native apps in the background — clicks, keyboard shortcuts, menu bar items, window sizes and the clipboard — and checks that each action took effect.',
  },
  {
    title: 'You decide where',
    desc: 'Allow or block Computer Use app by app. Several conversations can use it at once, and the agent’s pointer shows on screen as it works.',
  },
]

type TargetId = 'browser' | 'chrome' | 'mac'

const TARGETS: { id: TargetId; label: string; icon: ReactNode; steps: { call: string; result: string; active?: boolean }[] }[] = [
  {
    id: 'browser',
    label: 'In-app browser',
    icon: <GlobeIcon />,
    steps: [
      { call: "browser.navigate('localhost:3000/checkout')", result: 'loaded in 240 ms' },
      { call: 'browser.snapshot()', result: '38 interactive elements' },
      { call: "browser.click('Place order')", result: 'navigated to /confirm' },
      { call: 'browser.screenshot()', result: 'running…', active: true },
    ],
  },
  {
    id: 'chrome',
    label: 'Your Chrome',
    icon: <TabIcon />,
    steps: [
      { call: 'chrome.tabs()', result: '7 open tabs' },
      { call: "chrome.claim('Analytics · Weekly')", result: 'tab claimed' },
      { call: "chrome.click('Export CSV')", result: 'download started' },
      { call: 'chrome.read()', result: 'running…', active: true },
    ],
  },
  {
    id: 'mac',
    label: 'Mac apps',
    icon: <WindowIcon />,
    steps: [
      { call: "app.open('Numbers')", result: 'in the background' },
      { call: "app.menu('File › Export To › PDF')", result: 'dialog opened' },
      { call: "app.hotkey('cmd+s')", result: 'saved' },
      { call: 'app.verify()', result: 'running…', active: true },
    ],
  },
]

export function BrowserComputerSection() {
  const [activeId, setActiveId] = useState<TargetId>('browser')
  const active = TARGETS.find((t) => t.id === activeId) ?? TARGETS[0]

  return (
    <Section id="automation" tone="sidebar">
      <Reveal>
        <div className="max-w-2xl">
          <Eyebrow>Browser and Computer Use</Eyebrow>
          <Title>
            Your agents <Muted>have hands.</Muted>
          </Title>
          <Lead>
            Not just a panel to look at. Operon agents drive a built-in browser, your real Chrome and native
            Mac apps — clicking, typing and checking their own work.
          </Lead>
        </div>

        <div className="mt-10">
          <Window title="Agent session">
            <div className="flex gap-1 border-b border-border/50 px-3 py-2" role="tablist" aria-label="Target">
              {TARGETS.map((target) => (
                <button
                  key={target.id}
                  type="button"
                  role="tab"
                  aria-selected={target.id === activeId}
                  onClick={() => setActiveId(target.id)}
                  className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] transition-colors',
                    target.id === activeId ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-secondary-hover hover:text-foreground',
                  )}
                >
                  {target.icon}
                  {target.label}
                </button>
              ))}
            </div>
            <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="space-y-2 p-4 font-mono text-[12px] md:p-5">
                {active.steps.map((step) => (
                  <div key={step.call} className="flex items-start gap-2.5">
                    <span
                      className={cn(
                        'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                        step.active ? 'pulse-dot bg-brand' : 'bg-accent-green',
                      )}
                    />
                    <div className="min-w-0">
                      <div className="truncate text-foreground">{step.call}</div>
                      <div className="text-muted-foreground">{step.result}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="hidden border-l border-border/50 bg-sidebar p-5 md:block">
                <TargetPreview id={activeId} />
              </div>
            </div>
          </Window>
        </div>

        <div className="mt-10">
          <FeatureList items={FEATURES} columns={2} />
        </div>
      </Reveal>
    </Section>
  )
}

function TargetPreview({ id }: { id: TargetId }) {
  const url = id === 'browser' ? 'localhost:3000/checkout' : id === 'chrome' ? 'analytics.example.com/weekly' : null

  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-background">
      <div className="flex h-7 items-center gap-2 border-b border-border/50 px-2.5 text-[11px] text-muted-foreground">
        {url ? (
          <span className="flex-1 truncate rounded bg-muted px-2 py-0.5">{url}</span>
        ) : (
          <span>Numbers — Q3 report</span>
        )}
      </div>
      <div className="space-y-2.5 p-4">
        <div className="h-2.5 w-1/2 rounded bg-muted" />
        <div className="h-2 w-5/6 rounded bg-muted/70" />
        <div className="h-2 w-2/3 rounded bg-muted/70" />
        <div className="relative pt-2">
          <div className="inline-flex h-7 items-center rounded-lg bg-foreground px-3 text-[11px] text-background">
            {id === 'browser' ? 'Place order' : id === 'chrome' ? 'Export CSV' : 'Export'}
          </div>
          {/* The agent's pointer */}
          <svg width="16" height="16" viewBox="0 0 24 24" className="absolute top-7 left-[84px] text-brand" aria-hidden>
            <path fill="currentColor" stroke="white" strokeWidth="1.5" d="M4 3l7 18 2.5-7.5L21 11z" />
          </svg>
        </div>
      </div>
    </div>
  )
}

function GlobeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  )
}

function TabIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 9h18M8 5v4" />
    </svg>
  )
}

function WindowIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 8h18" />
      <circle cx="6" cy="6" r=".5" fill="currentColor" />
    </svg>
  )
}
