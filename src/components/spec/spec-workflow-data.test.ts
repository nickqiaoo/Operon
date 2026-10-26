import { describe, expect, it } from 'vitest'
import type { SpecAgentRun, SpecView } from '@shared/spec'
import { buildSpecWorkflow } from './spec-workflow-data'

const agent = (index: number, phase: string, label: string, state: SpecAgentRun['state'] = 'done'): SpecAgentRun => ({ runId: 'run', index, phase, label, state, startedAt: index * 1000, endedAt: index * 1000 + 500 })
const ticket = (key: string, state: SpecView['run']['build'][number]['state']): SpecView['run']['build'][number] => ({ key, taskId: Number(key.slice(1)), implementer: 'codex', reviewer: 'claude', rounds: 1, state })

function fixture(): SpecView {
  const seat = { providerId: 'codex' }
  return {
    taskId: 1, taskNumber: 1, title: 'Test spec', worktreePath: null, branchName: null, specDir: '', brief: '', grounding: '', candidates: [], judge: '', design: '', synthesis: '', tickets: [
      { key: 'T1', title: 'Data index', delivers: '', acceptance: [], blockedBy: [], interfaces: [] },
      { key: 'T2', title: 'Navigation', delivers: '', acceptance: [], blockedBy: [], interfaces: [] },
    ], questions: null, feedback: null, review: null, reviewSummary: null, running: true, providers: [], availableProviders: [], seats: [], designChanged: false, ticketTasks: {}, sourceChat: null, elapsedMs: 5000, coordinator: null, integration: null,
    run: { taskId: 1, stage: 'building', config: { lead: seat, explorer: seat, candidates: [seat], judge: seat, builder: seat }, designSha: null, workflowRunId: 'run', runIds: ['run'], build: [ticket('T1', 'merged'), ticket('T2', 'blocked')], rulings: [], error: null, proposal: null, createdAt: 0, updatedAt: 0 },
    agents: [
      agent(0, 'Ground', 'explorer · Data and state · codex'),
      agent(1, 'Design', 'candidate A · codex'),
      agent(2, 'Judge', 'judge · codex'),
      agent(3, 'Tickets', 'tickets · codex'),
      agent(4, 'Build', 'build T1 · codex'),
      agent(5, 'Build', 'review T1 · claude'),
      agent(6, 'Build', 'build T2 · codex'),
      agent(7, 'Build', 're-review T2 · claude', 'error'),
      agent(8, 'Unknown', 'unclassified · codex'),
    ],
  }
}

describe('Spec workflow grouping', () => {
  it('keeps the current explorer labels in separate nodes', () => {
    const spec = fixture()
    spec.agents = [
      agent(0, 'Ground', 'explorer · Data and state', 'running'),
      agent(1, 'Ground', 'explorer · Flow and surfaces', 'running'),
      agent(2, 'Ground', 'explorer · Conventions', 'running'),
      agent(3, 'Ground', 'explainer · codex'),
    ]
    spec.run.stage = 'grounding'
    expect(buildSpecWorkflow(spec)[0].lanes.map((lane) => lane.calls.length)).toEqual([1, 1, 1, 1])
  })

  it('keeps retries with their ticket and uses the ticket state', () => {
    const phases = buildSpecWorkflow(fixture())
    expect(phases.map((phase) => phase.calls.length)).toEqual([1, 1, 1, 1, 4, 0])
    expect(phases[4].lanes.map((lane) => [lane.key, lane.calls.length, lane.state])).toEqual([
      ['T1', 2, 'done'], ['T2', 2, 'attention'],
    ])
    expect(phases[4].state).toBe('attention')
    expect(phases[5].state).toBe('pending')
  })

  it('opens the latest recorded phase after a failure', () => {
    const spec = fixture()
    spec.run.stage = 'failed'
    spec.run.build = []
    expect(buildSpecWorkflow(spec).map((phase) => phase.state)).toEqual(['done', 'done', 'done', 'done', 'attention', 'pending'])
  })

  it('follows evaluation and planning within the designing stage', () => {
    const spec = fixture()
    spec.run.stage = 'designing'
    spec.run.build = []
    spec.tickets = null
    spec.agents = [agent(0, 'Judge', 'judge · codex', 'running')]
    expect(buildSpecWorkflow(spec)[2].state).toBe('running')
    spec.agents.push(agent(1, 'Builder check', 'builder check · codex', 'running'))
    expect(buildSpecWorkflow(spec)[3].state).toBe('running')
  })
})
