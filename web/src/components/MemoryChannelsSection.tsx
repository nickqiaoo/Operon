import type { ReactNode } from 'react'
import { Reveal } from './Reveal'
import { AgentAvatar, Eyebrow, Section } from './ui'
import { useCopy } from '../lib/i18n'

const COPY = {
  en: {
    memory: {
      eyebrow: 'Memory',
      title: 'Every conversation builds on the last.',
      desc: 'Operon remembers people, projects, what happened and how problems were solved — in your language, with dates — and brings the relevant bits into new conversations.',
      items: [
        { kind: 'User', text: 'Prefers pnpm and small, focused pull requests', date: 'Oct 2' },
        { kind: 'Event', text: 'Shipped the billing refactor (PR #212)', date: 'Oct 14' },
        { kind: 'Case', text: 'Duplicate webhooks fixed with an idempotency key', date: 'Sep 28' },
      ],
    },
    channels: {
      eyebrow: 'Channels',
      title: 'Agents, treated like teammates.',
      desc: 'Bring several agents into one room, @mention them like coworkers and let them disagree. Turn a thread into a task, or do the same inside your team’s Slack.',
      you: 'You',
      messages: [
        { from: 'You', text: '@codex @kimi which retry strategy for the webhooks?', you: true },
        { from: 'Codex', text: 'Exponential backoff, capped at five tries.' },
        { from: 'Kimi', text: 'Agree — and key each delivery so retries can’t double-charge.' },
      ] as Message[],
    },
  },
  zh: {
    memory: {
      eyebrow: '记忆',
      title: '聊过的事，下次还记得。',
      desc: 'Operon 会记下人、项目、发生过的事，还有问题当时是怎么解决的，用你习惯的语言，并标好日期。开新对话时，相关的内容会自动带上。',
      items: [
        { kind: '用户', text: '习惯用 pnpm，PR 喜欢拆小', date: '10月2日' },
        { kind: '事件', text: '计费重构已上线（PR #212）', date: '10月14日' },
        { kind: '案例', text: '用幂等键解决了 webhook 重复投递', date: '9月28日' },
      ],
    },
    channels: {
      eyebrow: '频道',
      title: '把 Agent 当同事。',
      desc: '把几个 Agent 拉进一个频道，像找同事一样 @ 它们，让它们各自说说看法。讨论完可以直接转成任务，在团队的 Slack 里也能这么用。',
      you: '我',
      messages: [
        { from: '我', text: '@codex @kimi webhook 的重试该用什么策略？', you: true },
        { from: 'Codex', text: '指数退避，最多重试五次。' },
        { from: 'Kimi', text: '同意。每次投递再加个唯一键，免得重试的时候重复扣款。' },
      ] as Message[],
    },
  },
}

interface Message {
  from: string
  text: string
  you?: boolean
}

/**
 * Two features that matter but no longer need a chapter each: memory now
 * mostly works through the assistant, and channels are a niche way to talk to
 * agents. Side by side, each says what it is in one card.
 */
export function MemoryChannelsSection() {
  const t = useCopy(COPY)

  return (
    <Section id="memory">
      <Reveal>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card
            eyebrow={t.memory.eyebrow}
            title={t.memory.title}
            desc={t.memory.desc}
          >
            <div className="space-y-2">
              {t.memory.items.map((m) => (
                <div key={m.text} className="flex items-center gap-3 rounded-lg border border-border/50 bg-sidebar px-3 py-2.5">
                  <span className="w-12 shrink-0 text-[11.5px] text-muted-foreground">{m.kind}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{m.text}</span>
                  <span className="shrink-0 text-[11.5px] text-muted-foreground">{m.date}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card
            eyebrow={t.channels.eyebrow}
            title={t.channels.title}
            desc={t.channels.desc}
          >
            <div className="space-y-2.5">
              {t.channels.messages.map((m) => (
                <div key={m.text} className="flex items-start gap-2.5">
                  {m.you ? (
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                      {t.channels.you.charAt(0)}
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
    <div className="flex flex-col rounded-xl border border-border/60 bg-background p-6 md:p-8">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h3 className="font-display text-[22px] leading-[1.2] font-semibold tracking-[-0.02em] text-foreground md:text-[26px]">{title}</h3>
      <p className="mt-3 text-[14.5px] leading-[1.65] text-muted-foreground">{desc}</p>
      <div className="mt-6" aria-hidden>
        {children}
      </div>
    </div>
  )
}
