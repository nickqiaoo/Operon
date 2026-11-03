import { Reveal } from './Reveal'
import { FeatureList, Lead, Muted, Section, Split, ThemedShot, Title } from './ui'
import specLight from '../assets/shots/spec-light.webp'
import specDark from '../assets/shots/spec-dark.webp'

const FEATURES = [
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
]

export function SddSection() {
  return (
    <Section id="sdd">
      <Reveal>
        <Split
          copy={
            <>
              <Title>
                Align first. <Muted>Then build.</Muted>
              </Title>
              <Lead>
                OperonSpec turns a request into a signed design before any code is written. Agree on what you want in
                a chat, and agents map the code, design it, check the design and split it into tickets. Use it when a
                change is too big to vibe-code.
              </Lead>
              <div className="mt-8">
                <FeatureList items={FEATURES} />
              </div>
            </>
          }
          visual={
            <ThemedShot
              light={specLight}
              dark={specDark}
              alt="An OperonSpec awaiting approval: Codex and Antigravity designed it, Antigravity judged, Codex merged the design and split it into six tickets"
              aspect="896 / 780"
            />
          }
        />
      </Reveal>
    </Section>
  )
}
