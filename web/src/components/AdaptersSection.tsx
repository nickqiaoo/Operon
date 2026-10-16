import { useState } from 'react'
import { Reveal } from './Reveal'
import { Eyebrow, Lead, MaskIcon, Muted, Section, Title } from './ui'
import { cn } from '../lib/styles'
import { AGENT_ICONS } from './agentMarks'

interface Adapter {
  id: string
  name: string
  icon: string
  vendor: string
  description: string
  features: string[]
}

const ADAPTERS: Adapter[] = [
  {
    id: 'operon',
    name: 'Operon Agent',
    icon: AGENT_ICONS.operon,
    vendor: 'Built in · any model',
    description:
      "Operon's own agent, not a wrapper around someone else's CLI. Bring a key for any of 8+ model providers and get the built-in tools, skills, MCP, memory, browser and Computer Use out of the box.",
    features: ['8+ model providers', 'Built-in tool system', 'Skills, MCP and plugins', 'Browser and Computer Use'],
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    icon: AGENT_ICONS.claude,
    vendor: 'Anthropic',
    description:
      'Runs on the Claude Agent SDK with your own subscription. Permission modes, thinking levels, sub-agents, background agents and slash commands all have proper UI, and your 5-hour and weekly usage sits in the title bar.',
    features: ['Permission modes incl. auto', 'Sub-agents and background agents', 'Slash commands', 'Live usage limits'],
  },
  {
    id: 'codex',
    name: 'Codex',
    icon: AGENT_ICONS.openai,
    vendor: 'OpenAI',
    description:
      'Built on the Codex App Server with full session management. Plan mode, fast mode, side chats, goals and sandbox modes, with your plan’s rate limits one hover away.',
    features: ['Plan and fast mode', 'Side chats', 'Sandbox modes', 'Rate-limit badge'],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    icon: AGENT_ICONS.cursor,
    vendor: 'Cursor',
    description:
      'Built on cursor-agent. Plan, Ask and Agent modes with the live model list from your account, and conversations that pick up where they left off after a restart.',
    features: ['Plan · Ask · Agent', 'Your account’s models', 'Session resume', 'Rich tool UI'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    icon: AGENT_ICONS.opencode,
    vendor: 'Open source',
    description:
      'Built on the OpenCode SDK with full feature parity. Use GLM, DeepSeek and every other provider OpenCode supports, with several tabs open at once and no crossed wires.',
    features: ['OpenCode SDK', 'Any OpenCode provider', 'Parallel tabs', 'Rich tool UI'],
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    icon: AGENT_ICONS.copilot,
    vendor: 'GitHub',
    description:
      'Built on the Copilot SDK. Interactive, Plan and Autopilot modes, configurable reasoning effort, and the model list that comes with your plan.',
    features: ['Interactive · Plan · Autopilot', 'Reasoning effort', 'Plan-specific models', 'Rich tool UI'],
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    icon: AGENT_ICONS.google,
    vendor: 'Google',
    description:
      'Google Antigravity over ACP. Settings installs it for you and tells you whether you are signed in, so a login page never appears halfway through a conversation.',
    features: ['One-click setup', 'Sign-in status', 'Session resume', 'Skills support'],
  },
  {
    id: 'grok',
    name: 'Grok',
    icon: AGENT_ICONS.grok,
    vendor: 'xAI',
    description:
      'Grok over ACP. Chat with it directly, or have another agent hand it a piece of work and report back.',
    features: ['ACP integration', 'Session resume', 'Takes delegated work', 'Rich tool UI'],
  },
  {
    id: 'kimi',
    name: 'Kimi Code',
    icon: AGENT_ICONS.kimi,
    vendor: 'Moonshot',
    description:
      "Moonshot's coding agent. Default, Plan and Full Access modes, slash commands like /compact, and streaming tool calls.",
    features: ['Default · Plan · Full Access', 'Slash commands', 'Session resume', 'Streaming tool calls'],
  },
]

export function AdaptersSection() {
  const [activeId, setActiveId] = useState(ADAPTERS[0].id)
  const active = ADAPTERS.find((a) => a.id === activeId) ?? ADAPTERS[0]

  return (
    <Section id="agents">
      <Reveal>
        <div className="max-w-2xl">
          <Eyebrow>Agents</Eyebrow>
          <Title>
            An agent of our own. <Muted>And every CLI you already pay for.</Muted>
          </Title>
          <Lead>
            Each agent runs on its official SDK or protocol, with your own login and subscription. Operon
            gives all of them the same chat, diff, review, terminal and approvals — and lets them work
            together.
          </Lead>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <div
            role="tablist"
            aria-label="Agents"
            className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0"
          >
            {ADAPTERS.map((adapter) => {
              const isActive = adapter.id === activeId
              return (
                <button
                  key={adapter.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveId(adapter.id)}
                  className={cn(
                    'flex h-10 shrink-0 items-center gap-3 rounded-lg px-3 text-left transition-colors',
                    isActive
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-secondary-hover hover:text-foreground',
                  )}
                >
                  <MaskIcon src={adapter.icon} size={16} />
                  <span className="text-[14px] whitespace-nowrap">{adapter.name}</span>
                  <span className="ml-auto hidden text-[12px] text-muted-foreground lg:inline">{adapter.vendor}</span>
                </button>
              )
            })}
          </div>

          <div className="rounded-xl border border-border/60 bg-sidebar p-6 md:p-8">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-border/60 bg-background text-foreground">
                <MaskIcon src={active.icon} size={20} />
              </span>
              <div>
                <div className="text-[17px] font-semibold text-foreground">{active.name}</div>
                <div className="text-[13px] text-muted-foreground">{active.vendor}</div>
              </div>
            </div>
            <p className="mt-5 max-w-2xl text-[15px] leading-[1.7] text-muted-foreground">{active.description}</p>
            <div className="mt-6 grid gap-2 sm:grid-cols-2">
              {active.features.map((feature) => (
                <div
                  key={feature}
                  className="flex items-center gap-2.5 rounded-lg border border-border/50 bg-background px-3 py-2.5 text-[13.5px] text-foreground"
                >
                  <CheckIcon />
                  {feature}
                </div>
              ))}
            </div>
          </div>
        </div>
      </Reveal>
    </Section>
  )
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-brand" aria-hidden>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}
