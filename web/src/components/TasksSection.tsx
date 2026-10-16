import { Reveal } from './Reveal'
import { Eyebrow, FeatureList, Lead, Muted, Section, ThemedShot, Title } from './ui'
import boardLight from '../assets/shots/board-light.webp'
import boardDark from '../assets/shots/board-dark.webp'

const FEATURES = [
  {
    title: 'A board for every project',
    desc: 'You and your agents create, assign and move tasks. Agents show up as avatars, and the toolbar takes you straight to managing them.',
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
]

export function TasksSection() {
  return (
    <Section id="tasks">
      <Reveal>
        <div className="max-w-2xl">
          <Eyebrow>Tasks</Eyebrow>
          <Title>
            Turn decisions <Muted>into tracked work.</Muted>
          </Title>
          <Lead>
            Every project gets a durable board shared by people and agents. Work comes in from chats, from
            the assistant or from Linear, gets its own branch, and leaves as a pull request.
          </Lead>
        </div>

        <div className="mt-10">
          <ThemedShot
            light={boardLight}
            dark={boardDark}
            alt="Operon task board for acme-web with tasks assigned to Claude Code, Codex and Cursor"
            aspect="1440 / 520"
          />
        </div>

        <div className="mt-10">
          <FeatureList items={FEATURES} columns={2} />
        </div>
      </Reveal>
    </Section>
  )
}
