import type { ReactNode } from 'react'
import { Reveal } from './Reveal'
import { AgentAvatar, Eyebrow, Section } from './ui'

const MEMORIES = [
  { kind: 'User', text: 'Prefers pnpm and small, focused pull requests', date: 'Oct 2' },
  { kind: 'Event', text: 'Shipped the billing refactor (PR #212)', date: 'Oct 14' },
  { kind: 'Case', text: 'Duplicate webhooks fixed with an idempotency key', date: 'Sep 28' },
]

const MESSAGES: { from: string; text: string; you?: boolean }[] = [
  { from: 'You', text: '@codex @kimi which retry strategy for the webhooks?', you: true },
  { from: 'Codex', text: 'Exponential backoff, capped at five tries.' },
  { from: 'Kimi', text: 'Agree — and key each delivery so retries can’t double-charge.' },
]

/**
 * Two features that matter but no longer need a chapter each: memory now
 * mostly works through the assistant, and channels are a niche way to talk to
 * agents. Side by side, each says what it is in one card.
 */
export function MemoryChannelsSection() {
  return (
    <Section id="memory">
      <Reveal>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card
            eyebrow="Memory"
            title="Every conversation builds on the last."
            desc="Operon remembers people, projects, what happened and how problems were solved — in your language, with dates — and brings the relevant bits into new conversations."
          >
            <div className="space-y-2">
              {MEMORIES.map((m) => (
                <div key={m.text} className="flex items-center gap-3 rounded-lg border border-border/50 bg-background px-3 py-2.5">
                  <span className="w-12 shrink-0 text-[11.5px] text-muted-foreground">{m.kind}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{m.text}</span>
                  <span className="shrink-0 text-[11.5px] text-muted-foreground">{m.date}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card
            eyebrow="Channels"
            title="Agents, treated like teammates."
            desc="Bring several agents into one room, @mention them like coworkers and let them disagree. Turn a thread into a task, or do the same inside your team’s Slack."
          >
            <div className="space-y-2.5">
              {MESSAGES.map((m) => (
                <div key={m.text} className="flex items-start gap-2.5">
                  {m.you ? (
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                      Y
                    </span>
                  ) : (
                    <AgentAvatar name={m.from} size={20} />
                  )}
                  <div className="min-w-0">
                    <span className="text-[12px] font-medium text-foreground">{m.from}</span>
                    <div className="text-[13px] leading-[1.5] text-muted-foreground">{m.text}</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </Reveal>
    </Section>
  )
}

function Card({ eyebrow, title, desc, children }: { eyebrow: string; title: string; desc: string; children: ReactNode }) {
  return (
    <div className="flex flex-col rounded-xl border border-border/60 bg-sidebar p-6 md:p-8">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h3 className="font-display text-[22px] leading-[1.2] font-semibold tracking-[-0.02em] text-foreground md:text-[26px]">{title}</h3>
      <p className="mt-3 text-[14.5px] leading-[1.65] text-muted-foreground">{desc}</p>
      <div className="mt-6" aria-hidden>
        {children}
      </div>
    </div>
  )
}
