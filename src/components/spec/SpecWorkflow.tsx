import { useEffect, useId, useRef, useState } from 'react'
import { ArrowRight, Check, CircleAlert, FileText, LoaderCircle } from 'lucide-react'
import { ProviderLabel } from '@/components/icons/ProviderLabel'
import { AgentRow } from '@/components/editor/components/WorkflowRunDetail'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { fileCitationsToText } from '@/lib/file-citation'
import type { SpecAgentRun, SpecChatRef, SpecView } from '@shared/spec'
import { buildSpecWorkflow, workflowDuration, type WorkflowArtifact, type WorkflowState } from './spec-workflow-data'
import { specWorkflowGraph } from './spec-workflow-graph'
import './spec-workflow.css'

function StateIcon({ state }: { state: WorkflowState }) {
  if (state === 'done') return <Check size={14} />
  if (state === 'running') return <LoaderCircle size={14} className="wf-spin" />
  if (state === 'attention') return <CircleAlert size={14} />
  return <span className="wf-pending-dot" />
}

function artifactAvailable(spec: SpecView, artifact: WorkflowArtifact): boolean {
  switch (artifact) {
    case 'brief': return !!(spec.brief || spec.grounding)
    case 'candidates': return spec.candidates.length > 0 || !!spec.judge
    case 'design': return !!spec.design
    case 'tickets': return !!spec.tickets
    case 'review': return !!spec.review
  }
}

function agentLabel(call: SpecAgentRun): string {
  const label = fileCitationsToText(call.label)
  const suffix = call.agentType ? ` · ${call.agentType}` : ''
  return suffix && label.endsWith(suffix) ? label.slice(0, -suffix.length) : label
}

function callState(call: SpecAgentRun, stage: SpecView['run']['stage']): WorkflowState {
  if (call.state === 'done') return 'done'
  if (call.state === 'error') return 'attention'
  if (call.state === 'queued') return 'pending'
  return stage === 'stopped' || stage === 'failed' ? 'attention' : 'running'
}

/** Every call is visible as a small node; output opens only when selected. */
export function SpecWorkflow({ spec, onOpenChat, onOpenArtifact }: {
  spec: SpecView
  onOpenChat?: (chat: SpecChatRef) => void
  onOpenArtifact: (artifact: WorkflowArtifact) => void
}) {
  const phases = buildSpecWorkflow(spec)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedCall, setSelectedCall] = useState<SpecAgentRun | null>(null)
  const current = phases.find((entry) => entry.state === 'attention' || entry.state === 'running') ?? phases.at(-1)!
  const phase = phases.find((entry) => entry.id === selectedId) ?? current
  const canvasRef = useRef<HTMLDivElement>(null)
  const [canvasWidth, setCanvasWidth] = useState(700)
  const markerId = useId()
  useEffect(() => {
    const element = canvasRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setCanvasWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const graph = specWorkflowGraph(phase.id, phase.calls, spec.tickets ?? [])
  const columns = Math.max(0, ...graph.map((node) => node.column)) + 1
  const nodeWidth = 230
  const nodeHeight = 66
  const contentWidth = columns * nodeWidth + (columns - 1) * 54 + 48
  const graphWidth = Math.max(canvasWidth, contentWidth)
  const graphHeight = Math.max(118, Math.max(0, ...graph.map((node) => node.row)) * 86 + nodeHeight + 48)
  const positions = new Map(graph.map((node) => [node.id, { x: (graphWidth - contentWidth) / 2 + 24 + node.column * (nodeWidth + 54), y: 24 + node.row * 86 }]))
  const total = phases.reduce((count, entry) => count + entry.calls.length, 0)
  const selectCall = (call: SpecAgentRun) => {
    const chat = call.chats?.at(-1)
    if (chat && onOpenChat) onOpenChat(chat)
    else setSelectedCall(call)
  }

  return <section className="spec-workflow" aria-label="Spec workflow">
    <header className="wf-summary">
      <span className={`wf-state ${current.state}`}><StateIcon state={current.state} /><span className="sr-only">{spec.run.stage}</span></span>
      <span>{total} agent calls <b>·</b> {Math.round(spec.elapsedMs / 60_000)}m</span>
      {artifactAvailable(spec, phase.artifact) && <button className="wf-open-artifact" aria-label={`Open ${phase.artifact}`} title={`Open ${phase.artifact}`} onClick={() => onOpenArtifact(phase.artifact)}><FileText size={14} /></button>}
    </header>
    <div className="wf-stages" aria-label="Workflow stages">
      {phases.map((entry, index) => <div className="wf-step-wrap" key={entry.id}>
        <button type="button" className={`wf-step ${phase.id === entry.id ? 'selected' : ''} ${entry.state}`} aria-pressed={phase.id === entry.id} onClick={() => setSelectedId(entry.id)}>
          <span className="wf-step-top"><strong>{entry.title}</strong><StateIcon state={entry.state} /></span>
          <span>{entry.calls.length} calls{workflowDuration(entry.calls) ? ` · ${workflowDuration(entry.calls)}` : ''}</span>
        </button>
        {index < phases.length - 1 && <ArrowRight className="wf-step-arrow" size={12} aria-hidden />}
      </div>)}
    </div>
    <div className="wf-agent-canvas" ref={canvasRef}>
      {phase.calls.length > 0 ? <div className="wf-graph" style={{ width: graphWidth, height: graphHeight }} role="list" aria-label={`${phase.title} agents`}>
        <svg className="wf-edges" width={graphWidth} height={graphHeight} aria-hidden>
          <defs><marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 1 1 L 7 4 L 1 7" fill="none" stroke="context-stroke" strokeWidth="1.4" /></marker></defs>
          {graph.flatMap((node) => node.parents.map((parent) => {
            const from = positions.get(parent)!
            const to = positions.get(node.id)!
            const x1 = from.x + nodeWidth
            const y1 = from.y + nodeHeight / 2
            const x2 = to.x - 3
            const y2 = to.y + nodeHeight / 2
            const bend = (x2 - x1) / 2
            return <path key={`${parent}:${node.id}`} className={`wf-edge ${callState(node.call, spec.run.stage)}`} d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`} markerEnd={`url(#${markerId})`} />
          }))}
        </svg>
        {graph.map((node) => {
          const call = node.call
          const position = positions.get(node.id)!
          const state = callState(call, spec.run.stage)
          const label = agentLabel(call)
          const provider = call.agentType ?? ''
          return <div className={`wf-agent-position ${state}`} style={{ left: position.x, top: position.y, width: nodeWidth, height: nodeHeight }} role="listitem" key={node.id}>
            <button className={`wf-agent-node ${state}`} title={`${label} · ${call.state}`} onClick={() => selectCall(call)}>
              <span className="wf-agent-top"><span className="wf-agent-name">{label}</span><span className="wf-state" aria-label={call.state}><StateIcon state={state} /></span></span>
              <span className="wf-agent-meta"><ProviderLabel id={provider} size={12}>{call.modelId ?? (provider || 'Spec agent')}</ProviderLabel>{state === 'running' ? <span className="wf-working">Running</span> : call.startedAt != null && call.endedAt != null ? <span>{Math.max(0, Math.round((call.endedAt - call.startedAt) / 1000))}s</span> : null}</span>
            </button>
          </div>
        })}
      </div> : <div className="wf-empty">{phase.state === 'pending' ? 'Not started' : 'No agent calls yet'}</div>}
    </div>
    <Dialog open={selectedCall != null} onOpenChange={(open) => { if (!open) setSelectedCall(null) }}>
      <DialogContent className="max-h-[80vh] overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{selectedCall ? agentLabel(selectedCall) : 'Agent'}</DialogTitle></DialogHeader>
        {selectedCall && <AgentRow runId={selectedCall.runId} agent={{ ...selectedCall, chatIds: selectedCall.chats?.map((chat) => chat.chatId) }} stream={undefined} referenceRootPath={selectedCall.chats?.at(-1)?.cwd ?? null} />}
      </DialogContent>
    </Dialog>
  </section>
}
