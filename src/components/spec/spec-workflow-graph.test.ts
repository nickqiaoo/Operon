import { describe, expect, it } from 'vitest'
import type { SpecAgentRun, SpecTicket } from '@shared/spec'
import { specWorkflowGraph } from './spec-workflow-graph'

const call = (index: number, label: string, agentType = 'codex'): SpecAgentRun => ({ runId: 'run', index, label, agentType, state: 'done' })

describe('Spec phase graph', () => {
  it('fans parallel explorers into the explainer', () => {
    const nodes = specWorkflowGraph('explore', [call(0, 'explorer · Data'), call(1, 'explorer · Flow'), call(2, 'explorer · Conventions'), call(3, 'explainer · codex')])
    expect(nodes.map((node) => node.column)).toEqual([0, 0, 0, 1])
    expect(nodes[3].parents).toEqual(['run:0', 'run:1', 'run:2'])
    expect(nodes[0].row).not.toBe(nodes[1].row)
  })

  it('keeps provider retries in their branch before the lead', () => {
    const nodes = specWorkflowGraph('verify', [call(0, 'review change · cursor', 'cursor'), call(1, 'review change · codex'), call(2, 'review change · cursor (retry 1)', 'cursor'), call(3, 'review change · cursor (retry 2)', 'cursor'), call(4, 'lead · codex')])
    expect(nodes.map((node) => node.parents)).toEqual([[], [], ['run:0'], ['run:2'], ['run:3', 'run:1']])
    expect(nodes[0].row).toBe(nodes[3].row)
    expect(nodes[4].column).toBeGreaterThan(nodes[3].column)
  })

  it('chains implementation and review per ticket, including blockers', () => {
    const tickets: SpecTicket[] = ['T1', 'T2'].map((key) => ({ key, title: key, delivers: '', acceptance: [], interfaces: [], blockedBy: key === 'T2' ? ['T1'] : [] }))
    const nodes = specWorkflowGraph('build', [call(0, 'build T1 · codex'), call(1, 'review T1 · codex'), call(2, 'rework T1 · codex'), call(3, 'build T2 · codex')], tickets)
    expect(nodes.map((node) => node.parents)).toEqual([[], ['run:0'], ['run:1'], ['run:2']])
  })
})
