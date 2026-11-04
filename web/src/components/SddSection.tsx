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
    titleA: '先把方案定下来，',
    titleB: '再写代码。',
    lead: 'OperonSpec 会在动代码之前，先把需求变成一份你确认过的设计。你在对话里说清楚想要什么，Agent 会去读代码、出设计、审设计，再拆成工单。改动大到不能边写边想的时候，就该用它。',
    alt: '一份等待审批的 OperonSpec：Codex 和 Antigravity 分别出设计，Antigravity 评审，Codex 合并设计并拆成六个工单',
    features: [
      {
        title: '你只需要确认两次',
        desc: '一次是批准设计，一次是验收最终改动。中间每个工单的实现、审查、合并都是自动的。',
      },
      {
        title: '几份设计比一比',
        desc: '不同厂商模型的 Agent 各出一份设计，由另一家的模型来打分，最后主导的 Agent 把好的部分合成一份。',
      },
      {
        title: '换一家模型来审',
        desc: '每个工单都交给和写代码的不是同一家的模型来审，验收前整条分支还会再审一遍。',
      },
      {
        title: '不推翻以前的决定',
        desc: '每个 Agent 都会先读仓库里已有的决策记录和术语表。设计要是和它们冲突，必须写清楚为什么。',
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
