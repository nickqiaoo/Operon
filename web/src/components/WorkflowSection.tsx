import { Reveal } from './Reveal'
import { Eyebrow, FeatureList, Lead, Muted, Section, Title, Window } from './ui'

const FEATURES = [
  {
    title: 'Twelve node types',
    desc: 'AI, session, shell, code, HTTP, template, if/else, loop groups, sub-workflows, approvals and more — deterministic steps cost nothing.',
  },
  {
    title: 'Any agent per node',
    desc: 'Each AI node picks its own agent and model, with optional JSON Schema so the next node can read fields directly.',
  },
  {
    title: 'Variables without typing',
    desc: 'Every field has a picker for upstream outputs, conditions are built row by row, and broken references are flagged before you save.',
  },
  {
    title: 'Parallel, scheduled, approved',
    desc: 'Nodes start the moment their inputs are ready, runs can be scheduled, and approval nodes pause for you on desktop or phone.',
  },
]

export function WorkflowSection() {
  return (
    <Section id="workflow" tone="sidebar">
      <Reveal>
        <div className="max-w-2xl">
          <Eyebrow>Workflows</Eyebrow>
          <Title>
            Build AI pipelines <Muted>on a canvas.</Muted>
          </Title>
          <Lead>
            When a job should run the same way every time, draw it. Mix agents with shell commands, HTTP
            calls and branches, and run the whole thing with one click or on a schedule.
          </Lead>
        </div>

        <div className="mt-10">
          <Window title="Nightly test triage">
            <div className="no-scrollbar overflow-x-auto">
              <WorkflowCanvas />
            </div>
          </Window>
        </div>

        <div className="mt-10">
          <FeatureList items={FEATURES} columns={2} />
        </div>
      </Reveal>
    </Section>
  )
}

type NodeKind = 'shell' | 'ai' | 'if' | 'http' | 'approval'

const KIND_LABEL: Record<NodeKind, string> = {
  shell: 'Shell',
  ai: 'AI',
  if: 'If / Else',
  http: 'HTTP',
  approval: 'Approval',
}

const NODES: { id: string; kind: NodeKind; x: number; y: number; title: string; sub: string; state?: 'done' | 'running' }[] = [
  { id: 'tests', kind: 'shell', x: 24, y: 150, title: 'Run tests', sub: 'pnpm test --reporter json', state: 'done' },
  { id: 'triage', kind: 'ai', x: 244, y: 150, title: 'Triage failures', sub: 'Claude Code · JSON schema', state: 'done' },
  { id: 'check', kind: 'if', x: 464, y: 150, title: 'triage.failing > 0', sub: '2 cases', state: 'done' },
  { id: 'fix', kind: 'ai', x: 704, y: 64, title: 'Fix the failure', sub: 'Codex · per item', state: 'running' },
  { id: 'review', kind: 'approval', x: 704, y: 160, title: 'Review before commit', sub: 'Inbox and phone' },
  { id: 'notify', kind: 'http', x: 704, y: 272, title: 'Post summary', sub: 'POST {{ env.SLACK_HOOK }}' },
]

const W = 184
const H = 62

function anchor(id: string, side: 'in' | 'out' | 'bottom' | 'top') {
  const n = NODES.find((node) => node.id === id)!
  if (side === 'in') return { x: n.x, y: n.y + H / 2 }
  if (side === 'out') return { x: n.x + W, y: n.y + H / 2 }
  if (side === 'bottom') return { x: n.x + W / 2, y: n.y + H }
  return { x: n.x + W / 2, y: n.y }
}

function curve(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = Math.max(40, (b.x - a.x) / 2)
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`
}

function vertical(a: { x: number; y: number }, b: { x: number; y: number }) {
  return `M ${a.x} ${a.y} L ${b.x} ${b.y}`
}

function WorkflowCanvas() {
  const edges = [
    { d: curve(anchor('tests', 'out'), anchor('triage', 'in')), active: false },
    { d: curve(anchor('triage', 'out'), anchor('check', 'in')), active: false },
    { d: curve(anchor('check', 'out'), { x: 690, y: 95 }), active: true, label: { x: 664, y: 112, text: 'failing' } },
    { d: vertical(anchor('fix', 'bottom'), anchor('review', 'top')), active: false },
    { d: curve(anchor('check', 'out'), anchor('notify', 'in')), active: false, label: { x: 664, y: 262, text: 'else' } },
  ]

  return (
    <svg viewBox="0 0 920 360" className="block w-full min-w-[760px]" role="img" aria-label="Workflow canvas with shell, AI, condition, loop, approval and HTTP nodes">
      <defs>
        <pattern id="wf-dots" width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" className="fill-border" />
        </pattern>
      </defs>
      <rect width="920" height="360" className="fill-sidebar" />
      <rect width="920" height="360" fill="url(#wf-dots)" />

      {/* Loop group */}
      <rect x="688" y="30" width="216" height="210" rx="12" className="fill-brand-muted stroke-brand/40" strokeDasharray="4 4" />
      <text x="700" y="50" className="fill-brand text-[11px] font-medium">Loop · for each failure</text>

      {edges.map((edge, i) => (
        <g key={i}>
          <path d={edge.d} fill="none" className={edge.active ? 'stroke-brand' : 'stroke-muted-foreground/50'} strokeWidth="1.5" />
          {edge.label && (
            <text x={edge.label.x} y={edge.label.y} textAnchor="middle" className="fill-muted-foreground text-[11px]">
              {edge.label.text}
            </text>
          )}
        </g>
      ))}

      {NODES.map((node) => (
        <g key={node.id} transform={`translate(${node.x} ${node.y})`}>
          <rect width={W} height={H} rx="10" className="fill-background stroke-border" strokeWidth="1" />
          {node.state === 'running' && <rect width={W} height={H} rx="10" fill="none" className="stroke-brand" strokeWidth="1.5" />}
          <text x="14" y="22" className="fill-muted-foreground text-[11px]">
            {KIND_LABEL[node.kind]}
          </text>
          {node.state && (
            <circle cx={W - 16} cy="18" r="3.5" className={node.state === 'done' ? 'fill-accent-green' : 'fill-brand pulse-dot'} />
          )}
          <text x="14" y="40" className="fill-foreground text-[13px] font-medium">
            {node.title}
          </text>
          <text x="14" y="54" className="fill-muted-foreground font-mono text-[10px]">
            {node.sub}
          </text>
        </g>
      ))}
    </svg>
  )
}
