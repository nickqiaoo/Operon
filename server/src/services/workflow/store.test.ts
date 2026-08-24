/**
 * The store's two list reads, and the difference between them.
 *
 * `listRunningRunViews` exists so the global feed can open without folding
 * history: it is held for the whole session by everything that has to notice a
 * run needing a human, and it used to open with a page of recent runs — work
 * that had finished days earlier, folded on every launch, for a panel that may
 * never open. These tests pin that it reads the running index only.
 *
 * better-sqlite3 can't load outside Electron on this arch (see resume.test.ts),
 * so the adapter is a fake; what is under test is the fold + which query is
 * asked, not SQL.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatStorageAdapter, WorkflowEventRow } from '../../storage/interface.js'
import type { WorkflowEvent } from './events.js'

const { getChatStorage } = vi.hoisted(() => ({ getChatStorage: vi.fn<() => ChatStorageAdapter | null>() }))
vi.mock('../ai/state.js', () => ({ getChatStorage }))

import { clearViewCache, listRunViews, listRunningRunViews } from './store.js'

let nextId = 1
function row(runId: string, event: WorkflowEvent): WorkflowEventRow {
  return { id: nextId++, runId, ts: nextId, kind: event.kind, data: JSON.stringify(event) }
}

function started(runId: string, name: string): WorkflowEventRow {
  return row(runId, { kind: 'started', chatId: 1, name, description: '', script: '', startedAt: 100 })
}

function settled(runId: string): WorkflowEventRow {
  return row(runId, { kind: 'settled', status: 'completed', endedAt: 200 })
}

/**
 * Events for three runs: one in flight, two finished. `runningIds` is what the
 * index reports as running — the real one is a column, here it is stated.
 */
function fakeStorage(spies: {
  listWorkflowRunIndex: ReturnType<typeof vi.fn>
  listRunningWorkflowRunIds: ReturnType<typeof vi.fn>
}): ChatStorageAdapter {
  const events: WorkflowEventRow[] = [
    started('live', 'nightly'),
    started('old-1', 'lint'),
    settled('old-1'),
    started('old-2', 'typecheck'),
    settled('old-2'),
  ]
  return {
    ...spies,
    readWorkflowEventsForRuns: (runIds: string[]) => events.filter((e) => runIds.includes(e.runId)),
  } as unknown as ChatStorageAdapter
}

describe('workflow store list reads', () => {
  let listWorkflowRunIndex: ReturnType<typeof vi.fn>
  let listRunningWorkflowRunIds: ReturnType<typeof vi.fn>

  beforeEach(() => {
    nextId = 1
    clearViewCache()
    listWorkflowRunIndex = vi.fn(() => [{ runId: 'live' }, { runId: 'old-1' }, { runId: 'old-2' }])
    listRunningWorkflowRunIds = vi.fn(() => ['live'])
    getChatStorage.mockReturnValue(fakeStorage({ listWorkflowRunIndex, listRunningWorkflowRunIds }))
  })

  it('lists only in-flight runs, folded', () => {
    const runs = listRunningRunViews()

    expect(runs.map((r) => r.runId)).toEqual(['live'])
    expect(runs[0].status).toBe('running')
    expect(runs[0].name).toBe('nightly')
  })

  it('never touches the history index — the whole point of the split', () => {
    listRunningRunViews()

    expect(listRunningWorkflowRunIds).toHaveBeenCalled()
    expect(listWorkflowRunIndex).not.toHaveBeenCalled()
  })

  it('still lists history when history is what was asked for', () => {
    const runs = listRunViews(30)

    expect(runs.map((r) => r.runId)).toEqual(['live', 'old-1', 'old-2'])
    expect(runs.map((r) => r.status)).toEqual(['running', 'completed', 'completed'])
  })

  it('folds a run once and serves the cached view after', () => {
    const readSpy = vi.spyOn(getChatStorage() as ChatStorageAdapter, 'readWorkflowEventsForRuns')

    listRunningRunViews()
    listRunningRunViews()

    expect(readSpy).toHaveBeenCalledTimes(1)
  })
})
