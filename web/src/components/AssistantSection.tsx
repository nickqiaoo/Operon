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
    titleB: '管住你所有项目。',
    lead: '一个凌驾于所有工作区之上的助理。告诉它你想做什么，它会把活交给合适的编程 Agent、盯着进度，只在真正需要你的时候才打扰你。它可以跑在 Codex、Claude Code、OpenCode 或 Operon 上——桌面和手机都能用。',
    alt: 'Operon 助理汇报 Codex 对一次限流改动的代码审查结果，旁边是它的活动列表',
    features: [
      {
        title: '替你推进编码工作',
        desc: '问它项目进展如何。它会在对应的工作区里启动 Codex、Claude Code 或其他 Agent，等它们做完或需要你时再来汇报。',
      },
      {
        title: '在卡片上直接回复',
        desc: '这些 Agent 的审批和提问会出现在对话里和收件箱中，安全的操作自动放行。',
      },
      {
        title: '多方意见',
        desc: '让几个 Agent 各出一版方案、互相回应，最后给你一个推荐结论。',
      },
      {
        title: '杂活它来干',
        desc: '你一句话，它就添加项目、新建工作区、开 PR、更新看板任务。',
      },
      {
        title: '心跳与定时任务',
        desc: '每 30 分钟按你们共同维护的清单过一遍。定时任务自己跑，结果写进当天的笔记。',
      },
      {
        title: '记得住事',
        desc: '把以后会用上的小事连同日期和细节记下来，更早的内容会去每日笔记里翻。',
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
