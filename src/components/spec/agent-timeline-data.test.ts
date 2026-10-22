import { describe, expect, it } from 'vitest'
import type { SpecAgentRun } from '@shared/spec'
import { buildAgentTimeline } from './agent-timeline-data'

const agent = (index: number, patch: Partial<SpecAgentRun>): SpecAgentRun => ({ runId: 'run', index, label: 'Designer · codex', agentType: 'codex', state: 'done', ...patch })

describe('Spec agent timeline', () => {
  it('preserves parallel intervals, gaps and model identity', () => {
    const result = buildAgentTimeline([
      agent(0, { startedAt: 1000, endedAt: 5000, modelId: 'test-model' }),
      agent(1, { startedAt: 2000, endedAt: 6000 }),
      agent(2, { startedAt: 8000, endedAt: 10000 }),
    ], false, 90000, 10000)!
    expect(result.elapsed).toBe(9)
    expect(result.agents[0]).toMatchObject({ role: 'Designer', model: 'test-model', start: 0, end: 4 })
    expect(result.orchestrator).toEqual([{ start: 0, end: 5, state: 'delegating' }, { start: 5, end: 7, state: 'working' }, { start: 7, end: 9, state: 'delegating' }])
  })

  it('keeps live intervals open and freezes interrupted runs', () => {
    const records = [agent(0, { startedAt: 1000, state: 'running' })]
    const live = buildAgentTimeline(records, true, 6000, 4000)!
    expect(live).toMatchObject({ elapsed: 5, running: true })
    expect(live.agents[0].end).toBeUndefined()
    expect(live.orchestrator[0].end).toBe(Infinity)
    const stopped = buildAgentTimeline(records, false, 90000, 4000)!
    expect(stopped).toMatchObject({ elapsed: 3, running: false })
    expect(stopped.agents[0]).toMatchObject({ end: 3, status: 'stopped' })
  })

  it('does not invent timing for queued or legacy agents, or animate failed calls', () => {
    expect(buildAgentTimeline([agent(0, { state: 'queued' })], true, 9000, 9000)).toBeNull()
    const result = buildAgentTimeline([agent(0, { state: 'error', startedAt: 1000, endedAt: 3000 }), agent(1, {})], true, 9000, 9000)!
    expect(result).toMatchObject({ elapsed: 2, running: false, untimed: 1 })
    expect(result.agents[0].status).toBe('failed')
  })
})
