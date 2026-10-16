import type { ReactNode } from 'react'
import { Reveal } from './Reveal'
import { Lead, Muted, Section, Title } from './ui'

const FEATURES: { title: string; desc: string; icon: ReactNode }[] = [
  {
    title: 'Inbox',
    desc: 'Finished chats, approvals and questions from every project in one place — answer them right in the row.',
    icon: <path d="M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z" />,
  },
  {
    title: 'Usage limits',
    desc: 'How much of your Claude Code and Codex quota is left, in the title bar, coloured as a window fills.',
    icon: <path d="M12 21a9 9 0 1 1 9-9M12 12l4-4" />,
  },
  {
    title: 'Auto permission mode',
    desc: 'A model reviews each risky action, so safe ones run on their own and the rest come to you.',
    icon: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4" />,
  },
  {
    title: 'Side chats',
    desc: 'Ask a quick question beside the main thread, or about a passage you selected, without derailing it.',
    icon: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />,
  },
  {
    title: 'Rewind',
    desc: 'Undo the latest turn’s file changes, or rewind the code to any earlier message.',
    icon: <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" />,
  },
  {
    title: 'Pull requests',
    desc: 'Titles and descriptions drafted from the diff, opened with your own gh login from the review toolbar.',
    icon: <path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9" />,
  },
  {
    title: 'Context window',
    desc: 'See where your tokens go, broken down and colour-coded by what is using them.',
    icon: <path d="M3 3h18v18H3zM3 9h18M9 21V9" />,
  },
  {
    title: 'Scheduled tasks',
    desc: 'Any agent can set up a recurring job from the conversation — daily, weekly or on an interval.',
    icon: <path d="M12 6v6l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z" />,
  },
  {
    title: 'Keyboard first',
    desc: 'Open files, review, browser, terminal and side chats from the keyboard, and rebind any shortcut.',
    icon: <path d="M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />,
  },
]

export function FeaturesSection() {
  return (
    <Section id="more">
      <Reveal>
        <div className="max-w-2xl">
          <Title>
            Small things. <Muted>Big difference.</Muted>
          </Title>
          <Lead>The details that make a long day of running agents less tiring.</Lead>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="rounded-xl border border-border/60 bg-background p-5 shadow-card">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/50 bg-sidebar text-muted-foreground">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  {feature.icon}
                </svg>
              </span>
              <h3 className="mt-4 text-[15px] font-medium text-foreground">{feature.title}</h3>
              <p className="mt-1.5 text-[13.5px] leading-[1.6] text-muted-foreground">{feature.desc}</p>
            </div>
          ))}
        </div>
      </Reveal>
    </Section>
  )
}
