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
    titleA: '定下来的事，',
    titleB: '放到看板上跟进。',
    lead: '一块跨项目的看板，人和 Agent 一起用。任务可以从对话、助理或 Linear 里来，每个任务单独拉一条分支，最后以 PR 交付。',
    alt: '跨两个项目的 Operon 任务看板，任务分别指派给 Claude Code、Codex 和 Cursor',
    features: [
      {
        title: '所有项目一块看板',
        desc: '你和 Agent 都能建任务、派任务、挪任务。可以看全部项目，也可以只看一个。Agent 显示成头像，从工具栏就能进去管理。',
      },
      {
        title: '和 Linear 双向同步',
        desc: '在 Linear 里把 issue 指派给 Operon，它就会变成一个任务，交给默认 Agent 去做。状态、优先级、评论两边同步。',
      },
      {
        title: '每个任务一条分支',
        desc: '派出去的任务在单独的工作区里跑，审阅时看到的只有这个任务改的文件。',
      },
      {
        title: 'Agent 自己开 PR',
        desc: '做完 Agent 会自己开 PR。不满意的话，任务负责人留条评论就能打回去重改。',
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
