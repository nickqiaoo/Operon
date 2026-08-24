/**
 * The fold is the single interpreter of the workflow event log — every screen,
 * every endpoint and the retention index all read through it. These cases pin
 * the behaviour the rest of the system assumes, and each of them is a bug the
 * previous snapshot-based design actually had.
 */

import { describe, it, expect } from 'vitest'
import { foldRunView } from './fold.js'
import type { StoredWorkflowEvent, WorkflowEvent } from './events.js'

const RUN = 'wf_test'

/** Number the events like the log would, so ordering is explicit in each case. */
function log(...events: WorkflowEvent[]): StoredWorkflowEvent[] {
  return events.map((event, i) => ({ id: i + 1, runId: RUN, ts: 1_000 + i, event }))
}

const started: WorkflowEvent = {
  kind: 'started',
  chatId: 7,
  name: 'demo',
  description: 'a demo run',
  script: 'export const meta = {}',
  startedAt: 1_000,
}

describe('foldRunView', () => {
  it('returns nothing for a log with no started event', () => {
    expect(foldRunView(RUN, log({ kind: 'log', message: 'orphan' }))).toBeUndefined()
  })

  it('merges agent patches instead of overwriting the record', () => {
    // The engine knows label/state/result; the host knows which agent type ran it
    // and how long it took. Neither may blank the other's fields — showing WHICH
    // agent ran a step is the entire point of this feature.
    const view = foldRunView(
      RUN,
      log(
        started,
        { kind: 'agent', index: 0, patch: { label: 'scan', state: 'running' } },
        { kind: 'agent', index: 0, patch: { agentType: 'codex', modelId: 'gpt-5', startedAt: 1_100 } },
        { kind: 'agent', index: 0, patch: { state: 'done', resultPreview: 'ok' } },
        { kind: 'agent', index: 0, patch: { endedAt: 1_900 } },
      ),
    )

    expect(view?.agents).toHaveLength(1)
    expect(view?.agents[0]).toMatchObject({
      index: 0,
      label: 'scan',
      state: 'done',
      resultPreview: 'ok',
      agentType: 'codex',
      modelId: 'gpt-5',
      startedAt: 1_100,
      endedAt: 1_900,
    })
  })

  it('keeps agents from the first attempt when a run is resumed', () => {
    // Resume re-appends `started` under the same runId, and the agents the
    // journal replays never run again — so their only record is the earlier
    // history. Dropping it left resumed runs showing a handful of agents with no
    // agentType and no duration.
    const view = foldRunView(
      RUN,
      log(
        started,
        { kind: 'agent', index: 0, patch: { label: 'first', state: 'done', agentType: 'codex' } },
        { kind: 'settled', status: 'interrupted', endedAt: 1_500 },
        { ...started, resumed: true },
        { kind: 'agent', index: 1, patch: { label: 'second', state: 'done', agentType: 'claude-code' } },
        { kind: 'settled', status: 'completed', endedAt: 2_000, result: 'done' },
      ),
    )

    expect(view?.status).toBe('completed')
    expect(view?.agents.map((a) => a.label)).toEqual(['first', 'second'])
    expect(view?.agents[0]?.agentType).toBe('codex')
    expect(view?.hasResult).toBe(true)
  })

  it('drops pending approvals once the run settles', () => {
    // A settled run cannot be waiting on anyone: whatever the sub-agent asked was
    // answered, denied or timed out. Leaving the request visible would render a
    // button that resolves nothing.
    const approval = {
      approvalId: 'ap1',
      agentId: 'codex-a0',
      toolName: 'Bash',
      requestedAt: 1_200,
    }
    const pending = foldRunView(RUN, log(started, { kind: 'approval', approval }))
    expect(pending?.pendingApprovals).toHaveLength(1)

    const settled = foldRunView(
      RUN,
      log(started, { kind: 'approval', approval }, { kind: 'settled', status: 'stopped', endedAt: 1_800 }),
    )
    expect(settled?.pendingApprovals).toEqual([])
    expect(settled?.status).toBe('stopped')
  })

  it('resolves an approval by id and ignores duplicates', () => {
    const approval = { approvalId: 'ap1', agentId: 'a', toolName: 'Bash', requestedAt: 1 }
    const view = foldRunView(
      RUN,
      log(
        started,
        { kind: 'approval', approval },
        { kind: 'approval', approval },
        { kind: 'approval', approval: { ...approval, approvalId: 'ap2' } },
        { kind: 'approval-resolved', approvalId: 'ap1' },
      ),
    )
    expect(view?.pendingApprovals.map((a) => a.approvalId)).toEqual(['ap2'])
  })

  it('marks an agent whose recording hit the byte cap', () => {
    const view = foldRunView(
      RUN,
      log(
        started,
        { kind: 'agent', index: 2, patch: { label: 'chatty' } },
        { kind: 'truncated', index: 2 },
      ),
    )
    expect(view?.agents.find((a) => a.index === 2)?.truncated).toBe(true)
  })

  it('ignores chunk and journal events entirely', () => {
    // Every view read excludes these kinds at the query level; the fold must give
    // the same answer either way, or a cached view and a fresh one could differ.
    const withNoise = foldRunView(
      RUN,
      log(
        started,
        { kind: 'chunk', index: 0, chunks: [{ type: 'text-delta', delta: 'hi' }] },
        { kind: 'journal', addr: 'workflow:wf_test', record: { type: 'custom' } },
      ),
    )
    expect(withNoise).toEqual(foldRunView(RUN, log(started)))
  })

  it('keeps log() narration out of failures', () => {
    // A successful run's own `log()` lines were being appended to `failures` and
    // rendered under a red "Failures" heading — the script saying "sending a
    // prompt…" read as something having gone wrong. Only the engine's terminal
    // outcome produces failures.
    const view = foldRunView(
      RUN,
      log(
        started,
        { kind: 'log', message: 'Sending a trivial prompt' },
        { kind: 'log', message: 'Got a response back' },
        { kind: 'settled', status: 'completed', endedAt: 2_000, result: 'ok', failures: [] },
      ),
    )
    expect(view?.logs).toEqual(['Sending a trivial prompt', 'Got a response back'])
    expect(view?.failures).toEqual([])
  })

  it('records real failures from the terminal outcome', () => {
    const view = foldRunView(
      RUN,
      log(
        started,
        { kind: 'log', message: 'narration' },
        { kind: 'settled', status: 'failed', endedAt: 2_000, error: 'boom', failures: ['agent 2 failed'] },
      ),
    )
    expect(view?.failures).toEqual(['agent 2 failed'])
    expect(view?.logs).toEqual(['narration'])
    expect(view?.error).toBe('boom')
  })

  it('orders agents by index regardless of arrival order', () => {
    const view = foldRunView(
      RUN,
      log(
        started,
        { kind: 'agent', index: 2, patch: { label: 'c' } },
        { kind: 'agent', index: 0, patch: { label: 'a' } },
        { kind: 'agent', index: 1, patch: { label: 'b' } },
      ),
    )
    expect(view?.agents.map((a) => a.label)).toEqual(['a', 'b', 'c'])
  })
})
