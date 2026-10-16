import { Reveal } from './Reveal'
import { Eyebrow, FeatureList, Lead, Muted, Section, ThemedShot, Title } from './ui'
import trioLight from '../assets/shots/trio-light.webp'
import trioDark from '../assets/shots/trio-dark.webp'

const FEATURES = [
  {
    title: 'Plain-language handoffs',
    desc: 'Ask any agent to bring in another one. No pipeline to configure — the plan is just the conversation.',
  },
  {
    title: 'Runs in the background',
    desc: 'Each helper works in its own tab and keeps going even if you close the one that started it.',
  },
  {
    title: 'Results come back',
    desc: 'When a helper finishes, its answer lands in the conversation that asked for it, ready for the next step.',
  },
  {
    title: 'Approve from the card',
    desc: 'If a helper needs permission or has a question, you answer it right on its card — and pick its reasoning effort up front.',
  },
]

export function ExternalAgentSection() {
  return (
    <Section id="orchestration">
      <Reveal>
        <div className="max-w-2xl">
          <Eyebrow>External agents</Eyebrow>
          <Title>
            One plans. One builds. <Muted>One reviews.</Muted>
          </Title>
          <Lead>
            Put several agents on the same job from a single conversation. Each one does the part it is
            best at and hands the result to the next.
          </Lead>
        </div>

        <div className="mt-10">
          <ThemedShot
            light={trioLight}
            dark={trioDark}
            alt="One Operon conversation where Claude Code plans a change, Codex builds it and Antigravity reviews it, each shown as a card with its status"
            aspect="2880 / 2080"
          />
        </div>

        <div className="mt-10">
          <FeatureList items={FEATURES} columns={2} />
        </div>
      </Reveal>
    </Section>
  )
}
