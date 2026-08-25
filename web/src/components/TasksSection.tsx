import { ZoomableImage } from './ImageZoom'
import { SectionShell } from './SectionShell'
import { Reveal } from './Reveal'
import { Eyebrow, SectionTitle, Lead, FeatureList, SplitLayout, ScreenshotFrame } from './SectionType'
import taskImg from '../assets/task.png'

const ACCENT = '#22c55e'

const FEATURES = [
  {
    title: 'Kanban board',
    desc: 'Plan work in columns, drag tasks across status, and keep every agent job visible.',
  },
  {
    title: 'Agent Teams',
    desc: 'Group related tasks so agents coordinate through a shared team inbox instead of scattered chat.',
  },
  {
    title: 'Branch per task',
    desc: 'Dispatch work into an isolated git worktree, then inspect the exact files the agent changed.',
  },
  {
    title: 'Live activity',
    desc: 'Comments, status changes, dispatch events, and wakeups stay attached to the task.',
  },
]

export function TasksSection() {
  return (
    <SectionShell id="tasks" accent={ACCENT} glow="left">
      <SplitLayout
        copyWidth={470}
        reverse
        copy={
          <Reveal>
            <Eyebrow>Tasks</Eyebrow>
            <SectionTitle>
              Turn decisions into
              <br />
              <span style={{ color: `${ACCENT}cc` }}>tracked work.</span>
            </SectionTitle>
            <Lead>
              Tasks gives every project a durable board where humans and agents create work, assign
              owners, dispatch branches, and follow progress without losing the thread.
            </Lead>
            <FeatureList items={FEATURES} accent={ACCENT} columns={2} />
          </Reveal>
        }
        visual={
          <Reveal delay={45}>
            <ScreenshotFrame aspectRatio="2274 / 1122">
              <ZoomableImage
                src={taskImg}
                alt="Operon task board with Kanban columns and agent team coordination"
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            </ScreenshotFrame>
          </Reveal>
        }
      />
    </SectionShell>
  )
}
