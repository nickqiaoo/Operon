import { Reveal } from './Reveal'
import { Eyebrow, FeatureList, Lead, Muted, Section, ThemedShot, Title } from './ui'
import { useCopy } from '../lib/i18n'
import trioLight from '../assets/shots/trio-light.webp'
import trioDark from '../assets/shots/trio-dark.webp'

const COPY = {
  en: {
    eyebrow: 'External agents',
    titleA: 'One plans. One builds. ',
    titleB: 'One reviews.',
    lead: 'Put several agents on the same job from a single conversation. Each one does the part it is best at and hands the result to the next.',
    alt: 'One Operon conversation where Claude Code plans a change, Codex builds it and Antigravity reviews it, each handoff a step with its agent, model and status',
    features: [
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
        title: 'Approve in place',
        desc: 'If a helper needs permission or has a question, you answer it right under its step in the conversation — and pick its reasoning effort up front.',
      },
    ],
  },
  zh: {
    eyebrow: '外部 Agent',
    titleA: '一个规划，一个实现，',
    titleB: '一个审查。',
    lead: '一件事可以在同一个对话里交给几个 Agent 接力完成，每个只做自己最拿手的那段，做完交给下一个。',
    alt: '一段 Operon 对话：Claude Code 规划改动、Codex 实现、Antigravity 审查，每次交接都是一个带 Agent、模型和状态的步骤',
    features: [
      {
        title: '说一句就能交接',
        desc: '直接让一个 Agent 去叫另一个来帮忙，不用事先配流水线，对话本身就是计划。',
      },
      {
        title: '在后台跑',
        desc: '被叫来的 Agent 在自己的 tab 里干活，把发起的那个 tab 关了也不会停。',
      },
      {
        title: '结果自动带回来',
        desc: '做完以后，结果会回到发起的那个对话里，接着往下走。',
      },
      {
        title: '就地审批',
        desc: '它要权限或者有疑问时，直接在对话里那一步下面回复就行。推理强度也可以提前设好。',
      },
    ],
  },
}

export function ExternalAgentSection() {
  const t = useCopy(COPY)

  return (
    <Section id="orchestration">
      <Reveal>
        <div className="max-w-2xl">
          <Eyebrow>{t.eyebrow}</Eyebrow>
          <Title>
            {t.titleA}<Muted>{t.titleB}</Muted>
          </Title>
          <Lead>{t.lead}</Lead>
        </div>

        <div className="mt-10">
          <ThemedShot light={trioLight} dark={trioDark} alt={t.alt} aspect="1440 / 978" />
        </div>

        <div className="mt-10">
          <FeatureList items={t.features} columns={2} />
        </div>
      </Reveal>
    </Section>
  )
}
