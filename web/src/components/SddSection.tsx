import { Reveal } from './Reveal'
import { FeatureList, Lead, Muted, Section, Split, ThemedShot, Title } from './ui'
import { useCopy } from '../lib/i18n'
import specLight from '../assets/shots/spec-light.webp'
import specDark from '../assets/shots/spec-dark.webp'

const COPY = {
  en: {
    titleA: 'Align first. ',
    titleB: 'Then build.',
    lead: 'OperonSpec turns a request into a signed design before any code is written. Agree on what you want in a chat, and agents map the code, design it, check the design and split it into tickets. Use it when a change is too big to vibe-code.',
    alt: 'An OperonSpec awaiting approval: Codex and Antigravity designed it, Antigravity judged, Codex merged the design and split it into six tickets',
    features: [
      {
        title: 'Two sign-offs',
        desc: 'You approve the design, then sign off the finished change. Building, reviewing and merging the tickets in between run on their own.',
      },
      {
        title: 'Designs that compete',
        desc: 'Agents from different model families each design the change; a judge from another family scores them, and the lead merges the best into one.',
      },
      {
        title: 'Reviewed by another family',
        desc: 'Every ticket is reviewed by an agent from a different family than the one that built it, and the whole branch is reviewed again before you sign.',
      },
      {
        title: 'Past decisions hold',
        desc: 'Every role reads the decision records and glossary your repo already keeps; a design that goes against one has to say so.',
      },
    ],
  },
  zh: {
    titleA: '先对齐，',
    titleB: '再动手。',
    lead: 'OperonSpec 在写任何代码之前，先把需求变成一份签过字的设计。在对话里把想要的东西说清楚，Agent 们会摸清代码、出设计、检查设计，再拆成工单。改动大到没法凭感觉写时就用它。',
    alt: '一份等待审批的 OperonSpec：Codex 和 Antigravity 分别出设计，Antigravity 评审，Codex 合并设计并拆成六个工单',
    features: [
      {
        title: '只签两次字',
        desc: '你批准设计，再签收最终改动。中间工单的实现、审查和合并都自动进行。',
      },
      {
        title: '设计方案互相竞争',
        desc: '来自不同模型家族的 Agent 各自出设计，另一家族的评委打分，主导者把最好的合成一份。',
      },
      {
        title: '跨家族审查',
        desc: '每个工单都由与实现者不同家族的 Agent 审查，签收前整条分支还会再审一遍。',
      },
      {
        title: '尊重过往决定',
        desc: '每个角色都会读仓库里已有的决策记录和术语表；设计若与之相悖，必须明确说明。',
      },
    ],
  },
}

export function SddSection() {
  const t = useCopy(COPY)

  return (
    <Section id="sdd">
      <Reveal>
        <Split
          copy={
            <>
              <Title>
                {t.titleA}<Muted>{t.titleB}</Muted>
              </Title>
              <Lead>{t.lead}</Lead>
              <div className="mt-8">
                <FeatureList items={t.features} />
              </div>
            </>
          }
          visual={<ThemedShot light={specLight} dark={specDark} alt={t.alt} aspect="896 / 780" />}
        />
      </Reveal>
    </Section>
  )
}
