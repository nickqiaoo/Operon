import { Reveal } from './Reveal'
import { Eyebrow, FeatureList, Lead, Muted, Section, Title, Window } from './ui'
import { useCopy } from '../lib/i18n'

const COPY = {
  en: {
    eyebrow: 'Workflows',
    titleA: 'Build AI pipelines ',
    titleB: 'on a canvas.',
    lead: 'When a job should run the same way every time, draw it. Mix agents with shell commands, HTTP calls and branches, and run the whole thing with one click or on a schedule.',
    window: 'Nightly test triage',
    features: [
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
    ],
  },
  zh: {
    eyebrow: '工作流',
    titleA: '在画布上',
    titleB: '搭 AI 流水线。',
    lead: '一件事每次都该按同样的步骤跑，那就把它画出来。把 Agent 和 shell 命令、HTTP 调用、分支组合起来，一键运行或按计划定时跑。',
    window: '夜间测试分诊',
    features: [
      {
        title: '十二种节点',
        desc: 'AI、会话、Shell、代码、HTTP、模板、条件分支、循环分组、子工作流、审批等等——确定性的步骤不花一分 token。',
      },
      {
        title: '每个节点任选 Agent',
        desc: '每个 AI 节点单独选 Agent 和模型，可选 JSON Schema，下一个节点直接读字段。',
      },
      {
        title: '变量不用手敲',
        desc: '每个字段都能从上游输出里点选，条件一行一行搭，失效的引用在保存前就会标出来。',
      },
      {
        title: '并行、定时、审批',
        desc: '输入一就绪节点立刻开跑，运行可以定时，审批节点会停下来等你在桌面或手机上确认。',
      },
    ],
  },
}

export function WorkflowSection() {
  const t = useCopy(COPY)

  return (
    <Section id="workflow" tone="sidebar">
      <Reveal>
        <div className="max-w-2xl">
          <Eyebrow>{t.eyebrow}</Eyebrow>
          <Title>
            {t.titleA}<Muted>{t.titleB}</Muted>
          </Title>
          <Lead>{t.lead}</Lead>
        </div>

        <div className="mt-10">
          <Window title={t.window}>
            <div className="no-scrollbar overflow-x-auto">
              <WorkflowCanvas />
            </div>
          </Window>
        </div>

        <div className="mt-10">
          <FeatureList items={t.features} columns={2} />
        </div>
      </Reveal>
    </Section>
  )
}

type NodeKind = 'shell' | 'ai' | 'if' | 'http' | 'approval'

const CANVAS_COPY = {
  en: {
    kinds: { shell: 'Shell', ai: 'AI', if: 'If / Else', http: 'HTTP', approval: 'Approval' } as Record<NodeKind, string>,
    nodes: {
      tests: { title: 'Run tests', sub: 'pnpm test --reporter json' },
      triage: { title: 'Triage failures', sub: 'Claude Code · JSON schema' },
      check: { title: 'triage.failing > 0', sub: '2 cases' },
      fix: { title: 'Fix the failure', sub: 'Codex · per item' },
      review: { title: 'Review before commit', sub: 'Inbox and phone' },
      notify: { title: 'Post summary', sub: 'POST {{ env.SLACK_HOOK }}' },
    } as Record<NodeId, { title: string; sub: string }>,
    loop: 'Loop · for each failure',
    failing: 'failing',
    else: 'else',
    aria: 'Workflow canvas with shell, AI, condition, loop, approval and HTTP nodes',
  },
  zh: {
    kinds: { shell: 'Shell', ai: 'AI', if: '条件分支', http: 'HTTP', approval: '审批' } as Record<NodeKind, string>,
    nodes: {
      tests: { title: '跑测试', sub: 'pnpm test --reporter json' },
      triage: { title: '分诊失败用例', sub: 'Claude Code · JSON schema' },
      check: { title: 'triage.failing > 0', sub: '2 个分支' },
      fix: { title: '修复失败用例', sub: 'Codex · 逐条处理' },
      review: { title: '提交前审核', sub: '收件箱与手机' },
      notify: { title: '发送总结', sub: 'POST {{ env.SLACK_HOOK }}' },
    } as Record<NodeId, { title: string; sub: string }>,
    loop: '循环 · 逐个失败用例',
    failing: '有失败',
    else: '否则',
    aria: '工作流画布，包含 Shell、AI、条件、循环、审批和 HTTP 节点',
  },
}

type NodeId = 'tests' | 'triage' | 'check' | 'fix' | 'review' | 'notify'

const NODES: { id: NodeId; kind: NodeKind; x: number; y: number; state?: 'done' | 'running' }[] = [
  { id: 'tests', kind: 'shell', x: 24, y: 150, state: 'done' },
  { id: 'triage', kind: 'ai', x: 244, y: 150, state: 'done' },
  { id: 'check', kind: 'if', x: 464, y: 150, state: 'done' },
  { id: 'fix', kind: 'ai', x: 704, y: 64, state: 'running' },
  { id: 'review', kind: 'approval', x: 704, y: 160 },
  { id: 'notify', kind: 'http', x: 704, y: 272 },
]

const W = 184
const H = 62

function anchor(id: NodeId, side: 'in' | 'out' | 'bottom' | 'top') {
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
  const t = useCopy(CANVAS_COPY)
  const edges = [
    { d: curve(anchor('tests', 'out'), anchor('triage', 'in')), active: false },
    { d: curve(anchor('triage', 'out'), anchor('check', 'in')), active: false },
    { d: curve(anchor('check', 'out'), { x: 690, y: 95 }), active: true, label: { x: 664, y: 112, text: t.failing } },
    { d: vertical(anchor('fix', 'bottom'), anchor('review', 'top')), active: false },
    { d: curve(anchor('check', 'out'), anchor('notify', 'in')), active: false, label: { x: 664, y: 262, text: t.else } },
  ]

  return (
    <svg viewBox="0 0 920 360" className="block w-full min-w-[760px]" role="img" aria-label={t.aria}>
      <defs>
        <pattern id="wf-dots" width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" className="fill-border" />
        </pattern>
      </defs>
      <rect width="920" height="360" className="fill-sidebar" />
      <rect width="920" height="360" fill="url(#wf-dots)" />

      {/* Loop group */}
      <rect x="688" y="30" width="216" height="210" rx="12" className="fill-brand-muted stroke-brand/40" strokeDasharray="4 4" />
      <text x="700" y="50" className="fill-brand text-[11px] font-medium">{t.loop}</text>

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
            {t.kinds[node.kind]}
          </text>
          {node.state && (
            <circle cx={W - 16} cy="18" r="3.5" className={node.state === 'done' ? 'fill-accent-green' : 'fill-brand pulse-dot'} />
          )}
          <text x="14" y="40" className="fill-foreground text-[13px] font-medium">
            {t.nodes[node.id].title}
          </text>
          <text x="14" y="54" className="fill-muted-foreground font-mono text-[10px]">
            {t.nodes[node.id].sub}
          </text>
        </g>
      ))}
    </svg>
  )
}
