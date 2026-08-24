/**
 * Resume validation — the crash → resume case the design requires (this path has
 * never run in production, so it is exercised deterministically here, no live
 * provider). Proves the journal shim + framework runWorkflow together give
 * "longest-unchanged-prefix" resume: a re-run under the same runId skips the
 * already-completed agent() calls and only re-runs the interrupted tail.
 *
 * The journal is backed by an in-memory fake of the two journal ops (their real
 * persistence — `journal` events in the run's log — is exercised by the store's
 * own tests). better-sqlite3 can't load outside Electron on this arch, so a fake
 * keeps the test hermetic while still exercising the real shim + engine.
 */

import { describe, it, expect } from 'vitest'
import { runWorkflow, WorkflowJournal, type WorkflowHostHooks } from 'operon-agents'
import { workflowJournalStore, type WorkflowJournalPort } from './journal-store.js'

const META = { name: 'resume-test', description: 'd' }
// 5 sequential sub-agents: a0..a4; return the last value.
const SCRIPT_BODY = `let last; for (let i = 0; i < 5; i++) { last = await agent('a' + i) } return last`

/** In-memory stand-in for the run's `journal` events (append-only, per run). */
function fakeJournalPort(): WorkflowJournalPort {
  const rows: { runId: string; addr: string; record: unknown }[] = []
  return {
    append: (runId, addr, record) => {
      rows.push({ runId, addr, record })
    },
    read: (runId) => rows.filter((r) => r.runId === runId).map((r) => ({ addr: r.addr, record: r.record })),
  }
}

/**
 * The identity the host assigns a sub-agent. Not decoration: the journal only keeps
 * `started`/`result` entries that carry an agentId, so a host that omits it journals
 * nothing readable and resume silently re-runs everything.
 */
function identityFor(prompt: string): { agentId: string; address: string } {
  return { agentId: `id-${prompt}`, address: `id-${prompt}` }
}

function hooksWith(runAgent: WorkflowHostHooks['runAgent']): WorkflowHostHooks {
  return {
    runAgent,
    emitProgress: () => {},
    concurrency: 1,
    budget: { total: null, getTurnSpent: () => 0 },
    abortSignal: new AbortController().signal,
  }
}

describe('workflow resume (journal shim)', () => {
  it('crash → resume: skips completed agents, re-runs only the interrupted tail', async () => {
    const runId = 'wf_resume_test'
    const port = fakeJournalPort() // one port == one durable journal across both rounds

    // Round 1: the 3rd sub-agent (a2) crashes → run fails after journaling a0/a1.
    const calls1: string[] = []
    const j1 = new WorkflowJournal(runId, workflowJournalStore(runId, port))
    await j1.load()
    const r1 = await runWorkflow({
      meta: META,
      scriptBody: SCRIPT_BODY,
      args: undefined,
      journal: j1,
      hooks: hooksWith(async ({ prompt, onStart }) => {
        onStart?.(identityFor(prompt))
        calls1.push(prompt)
        if (calls1.length === 3) throw new Error('boom')
        return { value: prompt, outputTokens: 0, ...identityFor(prompt) }
      }),
    })
    expect(r1.ok).toBe(false)
    expect(calls1).toEqual(['a0', 'a1', 'a2'])

    // Round 2: resume the SAME runId (fresh journal replays the persisted records).
    const calls2: string[] = []
    const j2 = new WorkflowJournal(runId, workflowJournalStore(runId, port))
    await j2.load()
    const r2 = await runWorkflow({
      meta: META,
      scriptBody: SCRIPT_BODY,
      args: undefined,
      journal: j2,
      hooks: hooksWith(async ({ prompt, onStart }) => {
        onStart?.(identityFor(prompt))
        calls2.push(prompt)
        return { value: prompt, outputTokens: 0, ...identityFor(prompt) }
      }),
    })
    expect(r2.ok).toBe(true)
    // a0 + a1 were cached (NOT re-run); only the interrupted tail re-ran.
    expect(calls2).toEqual(['a2', 'a3', 'a4'])
    expect(r2.ok && r2.result).toBe('a4')
  })
})
