import { ZoomableImage } from './ImageZoom'
import { SectionShell } from './SectionShell'
import { Reveal } from './Reveal'
import { SectionTitle, Lead, FeatureList, ScreenshotFrame } from './SectionType'
import { useIsMobile } from '../hooks/useIsMobile'
import workflowImg from '../assets/workflow.png'

const ACCENT = '#8b5cf6'

const FEATURES = [
  {
    title: 'DAG Execution Engine',
    desc: 'True parallel execution. Downstream nodes start the moment their inputs are ready.',
  },
  {
    title: 'Template Variables',
    desc: 'Reference any upstream output with {{nodeName}} syntax for flexible data flow.',
  },
  {
    title: 'Multi-Turn Orchestration',
    desc: 'Arrange multiple conversation turns within one session for complex, sequential tasks.',
  },
  {
    title: 'Scheduled Runs',
    desc: 'Set workflows on a cron schedule for automated, recurring execution.',
  },
]

export function WorkflowSection() {
  const mobile = useIsMobile()

  return (
    <SectionShell id="workflow" accent={ACCENT} glow="center" maxWidth={1240}>
      <Reveal>
        <div style={{ maxWidth: 720, marginBottom: mobile ? 28 : 38 }}>
          <SectionTitle>
            Build AI pipelines,
            <br />
            <span style={{ color: 'rgba(139,92,246,0.8)' }}>visually.</span>
          </SectionTitle>
          <Lead>
            Chain multiple AI models together on a visual canvas. Orchestrate multi-turn
            conversations within a single session, connect nodes, pass context between steps, and
            run entire workflows with one click.
          </Lead>
        </div>

        <ScreenshotFrame aspectRatio="16 / 7.2">
          <ZoomableImage
            src={workflowImg}
            alt="Canvas Workflow"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        </ScreenshotFrame>

        <div style={{ maxWidth: 980, marginTop: mobile ? 26 : 34 }}>
          <FeatureList items={FEATURES} accent={ACCENT} columns={2} />
        </div>
      </Reveal>
    </SectionShell>
  )
}
