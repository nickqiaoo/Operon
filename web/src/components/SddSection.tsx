import { ZoomableImage } from './ImageZoom'
import { SectionShell } from './SectionShell'
import { Reveal } from './Reveal'
import { SectionTitle, Lead, FeatureList, ScreenshotFrame } from './SectionType'
import { useIsMobile } from '../hooks/useIsMobile'
import specImg from '../assets/spec.png'

const ACCENT = '#0ea5e9'

const FEATURES = [
  {
    title: 'Approval gates',
    desc: 'Spec, plan, and acceptance each get a human sign-off before work moves on. Nobody starts coding before the design is approved.',
  },
  {
    title: 'Change packages in git',
    desc: 'spec.md, plan.md, and acceptance.md live on a branch under .operon/. The design lands in the same diff as the code, not in a database row.',
  },
  {
    title: 'Decompose & dispatch',
    desc: 'A large change splits into child tasks, each on its own branch, executed by the agent best suited for it. Fresh agents inherit context by reading the spec.',
  },
  {
    title: 'Sediments back',
    desc: 'When a change ships, its spec folds into a project-level living specification, so the next change starts from the current truth.',
  },
]

export function SddSection() {
  const mobile = useIsMobile()

  return (
    <SectionShell id="sdd" accent={ACCENT} glow="right" maxWidth={1280}>
      <Reveal>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: mobile ? '1fr' : 'minmax(0, 1.35fr) minmax(340px, 0.65fr)',
            alignItems: 'center',
            gap: mobile ? 30 : 54,
          }}
        >
          <div style={{ order: mobile ? 2 : 1 }}>
            <ScreenshotFrame aspectRatio="2800 / 1800">
              <ZoomableImage
                src={specImg}
                alt="Operon SDD change package with spec, plan, and acceptance approval gates"
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            </ScreenshotFrame>
          </div>

          <div style={{ order: mobile ? 1 : 2 }}>
            <SectionTitle>
              Align first.
              <br />
              <span style={{ color: `${ACCENT}cc` }}>Then build.</span>
            </SectionTitle>
            <Lead>
              SDD turns a one-line task into a reviewable change package: a written spec, a
              technical plan, and acceptance criteria, with approval gates between each stage. It
              pulls agents out of vibe coding into a controlled loop. Opt-in per channel; everything
              else works exactly as before.
            </Lead>
          </div>
        </div>

        <div style={{ maxWidth: 1040, marginTop: mobile ? 28 : 38 }}>
          <FeatureList items={FEATURES} accent={ACCENT} columns={2} />
        </div>
      </Reveal>
    </SectionShell>
  )
}
