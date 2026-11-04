import { Reveal } from './Reveal'
import { Eyebrow, FeatureList, Lead, Muted, Section, ThemedShot, Title } from './ui'
import { useCopy } from '../lib/i18n'
import boardLight from '../assets/shots/board-light.webp'
import boardDark from '../assets/shots/board-dark.webp'

const COPY = {
  en: {
    eyebrow: 'Tasks',
    titleA: 'Turn decisions ',
    titleB: 'into tracked work.',
    lead: 'One durable board across your projects, shared by people and agents. Work comes in from chats, from the assistant or from Linear, gets its own branch, and leaves as a pull request.',
    alt: 'Operon task board across two projects, with tasks assigned to Claude Code, Codex and Cursor',
    features: [
      {
        title: 'One board, every project',
        desc: 'You and your agents create, assign and move tasks. See every project at once or filter to one; agents show up as avatars, and the toolbar takes you straight to managing them.',
      },
      {
        title: 'Linear, both ways',
        desc: 'Delegate a Linear issue to Operon and it becomes a task run by your default agent. Status, priority and comments stay in sync.',
      },
      {
        title: 'A branch per task',
        desc: 'Dispatched work runs in its own workspace, so you review exactly the files that task touched.',
      },
      {
        title: 'Agents open the PR',
        desc: 'Agents open pull requests on their own, and a comment from the task owner sends them back to work.',
      },
    ],
  },
  zh: {
    eyebrow: '任务',
    titleA: '把决定',
    titleB: '变成可追踪的工作。',
    lead: '一块跨项目的持久看板，人和 Agent 共用。工作来自对话、助理或 Linear，各自拉一条分支，最后以 PR 交付。',
    alt: '跨两个项目的 Operon 任务看板，任务分别指派给 Claude Code、Codex 和 Cursor',
    features: [
      {
        title: '一块看板，所有项目',
        desc: '你和 Agent 都能创建、指派、挪动任务。可以一次看全部项目，也能只筛一个；Agent 以头像出现，工具栏一键进入管理。',
      },
      {
        title: '与 Linear 双向同步',
        desc: '把 Linear issue 委派给 Operon，它就变成一个由默认 Agent 执行的任务。状态、优先级和评论保持同步。',
      },
      {
        title: '一任务一分支',
        desc: '派发出去的工作在独立工作区里跑，你审阅的正好是这个任务改过的文件。',
      },
      {
        title: 'Agent 自己开 PR',
        desc: 'Agent 会自己开 pull request，任务负责人留一条评论就能把它打回去继续改。',
      },
    ],
  },
}

export function TasksSection() {
  const t = useCopy(COPY)

  return (
    <Section id="tasks" tone="sidebar">
      <Reveal>
        <div className="max-w-2xl">
          <Eyebrow>{t.eyebrow}</Eyebrow>
          <Title>
            {t.titleA}<Muted>{t.titleB}</Muted>
          </Title>
          <Lead>{t.lead}</Lead>
        </div>

        <div className="mt-10">
          <ThemedShot light={boardLight} dark={boardDark} alt={t.alt} aspect="1440 / 520" />
        </div>

        <div className="mt-10">
          <FeatureList items={t.features} columns={2} />
        </div>
      </Reveal>
    </Section>
  )
}
