import type { ReactNode } from 'react'
import { Reveal } from './Reveal'
import { Eyebrow, FeatureList, Lead, Muted, Section, ThemedShot, Title } from './ui'
import assistantLight from '../assets/shots/assistant-light.webp'
import assistantDark from '../assets/shots/assistant-dark.webp'

const FEATURES = [
  {
    title: 'Runs your coding work',
    desc: 'Ask how your projects are going. It starts Codex, Claude Code or any other agent in the right workspace and reports back when they finish or need you.',
  },
  {
    title: 'Answer on the card',
    desc: 'Approvals and questions from those agents show up in the conversation and in the inbox. Safe actions go through on their own.',
  },
  {
    title: 'Second opinions',
    desc: 'Have several agents propose a design, let them answer each other, and get one recommendation back.',
  },
  {
    title: 'Does the busywork',
    desc: 'Adds projects, creates workspaces, opens pull requests and updates board tasks when you ask.',
  },
  {
    title: 'Heartbeat and schedules',
    desc: 'Every 30 minutes it works through a checklist you keep together. Scheduled tasks run on their own and write into the day’s notes.',
  },
  {
    title: 'Remembers',
    desc: 'Keeps the small things that will matter later, with dates and details, and searches its daily notes for older ones.',
  },
]

export function AssistantSection() {
  return (
    <Section id="assistant" tone="sidebar">
      <Reveal>
        <div className="max-w-2xl">
          <Eyebrow>Assistant</Eyebrow>
          <Title>
            One conversation. <Muted>All of your projects.</Muted>
          </Title>
          <Lead>
            An assistant that sits above every workspace. Tell it what you want done; it hands the work to
            the right coding agent, keeps an eye on it, and only interrupts you when it matters. It runs on
            Codex, Claude Code, OpenCode or Operon — on your desktop and on your phone.
          </Lead>
        </div>

        <div className="mt-10">
          <ThemedShot
            light={assistantLight}
            dark={assistantDark}
            alt="The Operon assistant reporting a Codex code review of a rate-limit change, with its activity list beside it"
            aspect="1440 / 830"
          />
        </div>

        <div className="mt-10">
          <FeatureList items={FEATURES} columns={3} />
        </div>
      </Reveal>
    </Section>
  )
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1 py-px font-mono text-[0.9em] text-foreground">{children}</code>
}
