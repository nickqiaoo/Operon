import type { ReactNode } from 'react'
import { Reveal } from './Reveal'
import { Lead, Muted, Section, Title } from './ui'
import { useCopy } from '../lib/i18n'

const ICONS: ReactNode[] = [
  <path d="M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z" />,
  <path d="M12 21a9 9 0 1 1 9-9M12 12l4-4" />,
  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4" />,
  <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />,
  <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" />,
  <path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9" />,
  <path d="M3 3h18v18H3zM3 9h18M9 21V9" />,
  <path d="M12 6v6l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z" />,
  <path d="M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />,
]

/** Same order in both languages: each feature takes the icon at its index. */
const COPY = {
  en: {
    titleA: 'Small things. ',
    titleB: 'Big difference.',
    lead: 'The details that make a long day of running agents less tiring.',
    features: [
      { title: 'Inbox', desc: 'Finished chats, approvals and questions from every project in one place — answer them right in the row.' },
      { title: 'Usage limits', desc: 'How much of your Claude Code and Codex quota is left, in the title bar, coloured as a window fills.' },
      { title: 'Auto permission mode', desc: 'A model reviews each risky action, so safe ones run on their own and the rest come to you.' },
      { title: 'Side chats', desc: 'Ask a quick question beside the main thread, or about a passage you selected, without derailing it.' },
      { title: 'Rewind', desc: 'Undo the latest turn’s file changes, or rewind the code to any earlier message.' },
      { title: 'Pull requests', desc: 'Titles and descriptions drafted from the diff, opened with your own gh login from the review toolbar.' },
      { title: 'Context window', desc: 'See where your tokens go, broken down and colour-coded by what is using them.' },
      { title: 'Scheduled tasks', desc: 'Any agent can set up a recurring job from the conversation — daily, weekly or on an interval.' },
      { title: 'Keyboard first', desc: 'Open files, review, browser, terminal and side chats from the keyboard, and rebind any shortcut.' },
    ],
  },
  zh: {
    titleA: '小细节，',
    titleB: '大不同。',
    lead: '让一整天跑 Agent 不那么累的那些细节。',
    features: [
      { title: '收件箱', desc: '所有项目里完成的对话、审批和提问集中在一处——在那一行里直接回复。' },
      { title: '额度显示', desc: 'Claude Code 和 Codex 还剩多少额度，就显示在标题栏，快用完时会变色。' },
      { title: 'Auto 权限模式', desc: '由模型审查每个有风险的操作，安全的自动放行，其余的交给你决定。' },
      { title: '旁支对话', desc: '在主线旁边快速问个问题，或针对选中的一段提问，不打断主线。' },
      { title: '回退', desc: '撤销最近一轮的文件改动，或把代码回退到之前任意一条消息。' },
      { title: 'Pull Request', desc: '标题和描述根据 diff 自动起草，在审阅工具栏里用你自己的 gh 登录直接开 PR。' },
      { title: '上下文窗口', desc: '看清 token 都花在哪，按用途拆分并分色显示。' },
      { title: '定时任务', desc: '任何 Agent 都能在对话里设置周期任务——每天、每周或按固定间隔。' },
      { title: '键盘优先', desc: '文件、审阅、浏览器、终端和旁支对话都能用键盘打开，快捷键可任意改绑。' },
    ],
  },
}

export function FeaturesSection() {
  const t = useCopy(COPY)

  return (
    <Section id="more">
      <Reveal>
        <div className="max-w-2xl">
          <Title>
            {t.titleA}<Muted>{t.titleB}</Muted>
          </Title>
          <Lead>{t.lead}</Lead>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {t.features.map((feature, i) => (
            <div key={feature.title} className="rounded-xl border border-border/60 bg-background p-5 shadow-card">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/50 bg-sidebar text-muted-foreground">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  {ICONS[i]}
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
