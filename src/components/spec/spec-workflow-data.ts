import type { SpecAgentRun, SpecStage, SpecTicketBuild, SpecView } from '@shared/spec'
import { fileCitationsToText } from '@/lib/file-citation'

export const WORKFLOW_PHASES = [
  { id: 'explore', title: 'Explore', artifact: 'brief' },
  { id: 'design', title: 'Design', artifact: 'candidates' },
  { id: 'evaluate', title: 'Evaluate', artifact: 'candidates' },
  { id: 'plan', title: 'Plan', artifact: 'design' },
  { id: 'build', title: 'Build', artifact: 'tickets' },
  { id: 'verify', title: 'Verify', artifact: 'review' },
] as const

export type WorkflowPhaseId = (typeof WORKFLOW_PHASES)[number]['id']
export type WorkflowState = 'done' | 'running' | 'attention' | 'pending'
export type WorkflowArtifact = 'brief' | 'candidates' | 'design' | 'tickets' | 'review'

export interface WorkflowLane {
  key: string
  title: string
  subtitle: string
  state: WorkflowState
  calls: SpecAgentRun[]
  artifact: WorkflowArtifact | null
  ticketKey?: string
  note?: string
}

export interface WorkflowPhase {
  id: WorkflowPhaseId
  title: string
  state: WorkflowState
  calls: SpecAgentRun[]
  lanes: WorkflowLane[]
  artifact: WorkflowArtifact
}

const CURRENT_PHASE: Record<SpecStage, number> = {
  grounding: 0, designing: 1, awaiting_answers: 3, awaiting_design: 3,
  building: 4, reviewing: 5, awaiting_signoff: 5, integrating: 5,
  done: 6, stopped: -1, failed: -1,
}

function phaseFor(agent: SpecAgentRun): WorkflowPhaseId | null {
  switch (agent.phase?.toLowerCase()) {
    case 'ground': return 'explore'
    case 'design': return 'design'
    case 'judge': return 'evaluate'
    case 'synthesize':
    case 'revise':
    case 'builder check':
    case 'tickets': return 'plan'
    case 'build': return 'build'
    case 'review': return 'verify'
    default: return null
  }
}

function currentIndex(spec: Pick<SpecView, 'run' | 'agents' | 'design' | 'tickets' | 'review'>): number {
  const stageIndex = CURRENT_PHASE[spec.run.stage]
  if (spec.run.stage === 'designing') {
    const latest = [...spec.agents].reverse().find((agent) => {
      if (spec.run.workflowRunId && agent.runId !== spec.run.workflowRunId) return false
      return ['design', 'evaluate', 'plan'].includes(phaseFor(agent) ?? '')
    })
    if (latest) return WORKFLOW_PHASES.findIndex((phase) => phase.id === phaseFor(latest))
  }
  if (stageIndex >= 0) return stageIndex
  const latest = [...spec.agents].reverse().find((agent) => phaseFor(agent) != null)
  if (latest) return WORKFLOW_PHASES.findIndex((phase) => phase.id === phaseFor(latest))
  return spec.review ? 5 : spec.tickets ? 4 : spec.design ? 3 : 0
}

function laneState(calls: SpecAgentRun[], fallback: WorkflowState, ticket?: SpecTicketBuild): WorkflowState {
  if (ticket?.state === 'blocked') return 'attention'
  if (ticket?.state === 'merged') return 'done'
  if (ticket?.state === 'building' || ticket?.state === 'reviewing') return 'running'
  if (calls.some((call) => call.state === 'running')) return 'running'
  if (fallback === 'done') return 'done'
  if (calls.length > 0 && calls.at(-1)?.state === 'error') return 'attention'
  if (calls.length > 0 && calls.every((call) => call.state === 'done' || call.state === 'error')) return 'done'
  return fallback
}

function durationOf(calls: SpecAgentRun[]): number {
  const start = Math.min(...calls.flatMap((call) => call.startedAt == null ? [] : [call.startedAt]))
  const end = Math.max(...calls.flatMap((call) => call.endedAt == null ? [] : [call.endedAt]))
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : 0
}

export function workflowDuration(calls: SpecAgentRun[]): string | null {
  const ms = durationOf(calls)
  if (ms <= 0) return null
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

function addLane(lanes: WorkflowLane[], key: string, title: string, call: SpecAgentRun, artifact: WorkflowArtifact, subtitle = '') {
  let lane = lanes.find((entry) => entry.key === key)
  if (!lane) {
    lane = { key, title, subtitle, state: 'pending', calls: [], artifact }
    lanes.push(lane)
  }
  lane.calls.push(call)
}

/** Groups recorded calls without inferring dependencies that the run did not record. */
export function buildSpecWorkflow(spec: SpecView): WorkflowPhase[] {
  const active = currentIndex(spec)
  const interrupted = spec.run.stage === 'failed' || spec.run.stage === 'stopped'
  const phases: WorkflowPhase[] = WORKFLOW_PHASES.map((definition, index) => ({
    ...definition,
    state: index < active || spec.run.stage === 'done' ? 'done' : index > active ? 'pending' : interrupted || ['awaiting_answers', 'awaiting_design', 'awaiting_signoff'].includes(spec.run.stage) ? 'attention' : 'running',
    calls: [],
    lanes: [],
  }))
  for (const call of spec.agents) {
    const id = phaseFor(call)
    if (!id) continue
    const phase = phases.find((entry) => entry.id === id)!
    phase.calls.push(call)
    const fullLabel = fileCitationsToText(call.label)
    const suffix = call.agentType ? ` · ${call.agentType}` : ''
    const label = suffix && fullLabel.endsWith(suffix) ? fullLabel.slice(0, -suffix.length) : fullLabel
    if (id === 'explore') {
      const key = label.startsWith('explorer · ') ? label : 'Context synthesis'
      addLane(phase.lanes, key, key === 'Context synthesis' ? key : label.replace('explorer · ', ''), call, 'brief')
    } else if (id === 'design') {
      const key = label.startsWith('candidate ') ? label : 'Shared context'
      addLane(phase.lanes, key, key === 'Shared context' ? key : label.replace(/^candidate /, 'Candidate '), call, 'candidates')
    } else if (id === 'evaluate') {
      addLane(phase.lanes, 'judge', 'Design evaluation', call, 'candidates')
    } else if (id === 'plan') {
      addLane(phase.lanes, 'plan', 'Design & ticket plan', call, 'design')
    } else if (id === 'build') {
      const key = spec.tickets?.find((ticket) => new RegExp(`\\b${ticket.key}\\b`, 'i').test(label))?.key
      const ticket = spec.tickets?.find((entry) => entry.key === key)
      addLane(phase.lanes, key ?? 'coordination', ticket ? `${ticket.key} · ${fileCitationsToText(ticket.title)}` : 'Build coordination', call, 'tickets')
    } else {
      const key = fullLabel.startsWith('review change · ') ? fullLabel : 'Review synthesis'
      addLane(phase.lanes, key, key === 'Review synthesis' ? key : `Reviewer · ${fullLabel.slice('review change · '.length)}`, call, 'review')
    }
  }

  for (const phase of phases) {
    if (phase.id === 'build') {
      for (const ticket of spec.tickets ?? []) {
        if (!phase.lanes.some((lane) => lane.key === ticket.key)) {
          phase.lanes.push({ key: ticket.key, title: `${ticket.key} · ${fileCitationsToText(ticket.title)}`, subtitle: '', state: 'pending', calls: [], artifact: 'tickets', ticketKey: ticket.key })
        }
      }
    }
    for (const lane of phase.lanes) {
      const ticket = phase.id === 'build' ? spec.run.build.find((entry) => entry.key === lane.key) : undefined
      lane.ticketKey = ticket?.key ?? lane.ticketKey
      lane.state = laneState(lane.calls, phase.state, ticket)
      if (ticket?.blockedReason) lane.note = ticket.blockedReason
      else if (ticket?.openIssues?.length) lane.note = ticket.openIssues.join(' · ')
    }
    // A phase with recorded calls is not complete while any call is still active.
    if (phase.calls.some((call) => call.state === 'running') && phase.state === 'done') phase.state = 'running'
    if (phase.id === 'build' && phase.lanes.some((lane) => lane.state === 'attention') && !phase.lanes.some((lane) => lane.state === 'running')) phase.state = 'attention'
  }
  return phases
}
