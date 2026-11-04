import type { ReactNode } from 'react'
import { Reveal } from './Reveal'
import { Eyebrow, FeatureList, Lead, Muted, Section, ThemedShot, Title } from './ui'
import { useCopy } from '../lib/i18n'
import assistantLight from '../assets/shots/assistant-light.webp'
import assistantDark from '../assets/shots/assistant-dark.webp'

const COPY = {
  en: {
    eyebrow: 'Assistant',
    titleA: 'One conversation. ',
    titleB: 'All of your projects.',
    lead: 'An assistant that sits above every workspace. Tell it what you want done; it hands the work to the right coding agent, keeps an eye on it, and only interrupts you when it matters. It runs on Codex, Claude Code, OpenCode or Operon — on your desktop and on your phone.',
    alt: 'The Operon assistant reporting a Codex code review of a rate-limit change, with its activity list beside it',
    features: [
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
    ],
  },
  zh: {
    eyebrow: '助理',
    titleA: '一个对话，',
    titleB: '照看所有项目。',
    lead: '助理不属于任何一个工作区，能看到你所有的项目。你说要做什么，它把活儿派给合适的编程 Agent，替你盯进度，非得你拍板的时候才来找你。底下可以用 Codex、Claude Code、OpenCode 或 Operon 自己的 Agent，桌面和手机上都能用。',
    alt: 'Operon 助理汇报 Codex 对一次限流改动的代码审查结果，旁边是它的活动列表',
    features: [
      {
        title: '帮你推进开发',
        desc: '问它项目做到哪了，它会去对应的工作区里叫 Codex、Claude Code 或别的 Agent 干活，做完了或者卡住了再来告诉你。',
      },
      {
        title: '在卡片上直接回复',
        desc: 'Agent 要审批、有疑问，都会出现在对话和收件箱里。没风险的操作直接放行。',
      },
      {
        title: '多听几家意见',
        desc: '让几个 Agent 各出一版方案，互相挑毛病，最后给你一个推荐。',
      },
      {
        title: '杂事交给它',
        desc: '加项目、建工作区、开 PR、更新看板，说一句就行。',
      },
      {
        title: '定时巡检',
        desc: '每 30 分钟对着你们一起维护的清单检查一遍。定时任务会自己跑，结果记到当天的笔记里。',
      },
      {
        title: '记性好',
        desc: '以后用得上的事，它会连日期和细节一起记下来；更早的事会去每天的笔记里找。',
      },
    ],
  },
}

export function AssistantSection() {
  const t = useCopy(COPY)

  return (
    <Section id="assistant" tone="sidebar">
      <Reveal>
        <div className="max-w-2xl">
          <Eyebrow>{t.eyebrow}</Eyebrow>
          <Title>
            {t.titleA}<Muted>{t.titleB}</Muted>
          </Title>
          <Lead>{t.lead}</Lead>
        </div>

        <div className="mt-10">
          <ThemedShot light={assistantLight} dark={assistantDark} alt={t.alt} aspect="1440 / 900" />
        </div>

        <div className="mt-10">
          <FeatureList items={t.features} columns={3} />
        </div>
      </Reveal>
    </Section>
  )
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1 py-px font-mono text-[0.9em] text-foreground">{children}</code>
}
