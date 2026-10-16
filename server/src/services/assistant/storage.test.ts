import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { SqliteStorage } from '../../storage/sqlite.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operon-assistant-storage-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

// better-sqlite3 is built for Electron's Node; under a plain Node it does not load. Run with
// `ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run <this file>` to cover it.
let opened: SqliteStorage | undefined
try {
  opened = new SqliteStorage(path.join(dir, 'test.db'))
} catch {
  opened = undefined
}
const storage = opened as SqliteStorage

describe.skipIf(!opened)('assistant storage', () => {
  it('pages the thread newest-first but returns each page oldest-first', () => {
    for (let i = 1; i <= 5; i++) {
      storage.assistantMessageUpsert({
        id: `m${i}`,
        role: i % 2 ? 'user' : 'assistant',
        text: `t${i}`,
        createdAt: i * 10,
        ...(i === 4 ? { trigger: { kind: 'worker' as const, activityId: 'a1' }, activityId: 'a1', remembered: ['x'] } : {}),
      })
    }
    expect(storage.assistantMessageList({ limit: 2 }).map((m) => m.id)).toEqual(['m4', 'm5'])
    expect(storage.assistantMessageList({ limit: 2, before: 40 }).map((m) => m.id)).toEqual(['m2', 'm3'])
    expect(storage.assistantMessageList({ limit: 10 }).find((m) => m.id === 'm4')).toEqual({
      id: 'm4',
      role: 'assistant',
      text: 't4',
      createdAt: 40,
      trigger: { kind: 'worker', activityId: 'a1' },
      activityId: 'a1',
      remembered: ['x'],
    })
  })

  it('upserts an activity with its steps', () => {
    const base = { id: 'a1', taskId: 'agent-1', title: 'T', summary: 'Working…', status: 'running' as const, startedAt: 5, steps: [] }
    storage.assistantActivityUpsert(base)
    storage.assistantActivityUpsert({
      ...base,
      status: 'done',
      summary: 'ok',
      finishedAt: 9,
      report: 'r',
      steps: [{ id: 's', label: 'L', status: 'done', tool: 'Read', args: { path: 'x' }, result: 'y', at: 6 }],
    })
    storage.assistantActivityUpsert({ ...base, id: 'a2', startedAt: 7 })
    expect(storage.assistantActivityGet('a1')).toEqual({
      ...base,
      status: 'done',
      summary: 'ok',
      finishedAt: 9,
      report: 'r',
      steps: [{ id: 's', label: 'L', status: 'done', tool: 'Read', args: { path: 'x' }, result: 'y', at: 6 }],
    })
    expect(storage.assistantActivityList(10).map((a) => a.id)).toEqual(['a2', 'a1'])
    expect(storage.assistantActivityGet('nope')).toBeNull()
  })

  it('lists activities without their steps: the newest, or the asked-for ones plus those at work', () => {
    // a1 (done, with steps) and a2 (running) from the test above.
    expect(storage.assistantActivitySummaries({ limit: 10 })).toEqual([
      { id: 'a2', taskId: 'agent-1', title: 'T', summary: 'Working…', status: 'running', startedAt: 7 },
      { id: 'a1', taskId: 'agent-1', title: 'T', summary: 'ok', status: 'done', startedAt: 5, finishedAt: 9 },
    ])
    expect(storage.assistantActivitySummaries({ ids: [], live: true }).map((a) => a.id)).toEqual(['a2'])
    expect(storage.assistantActivitySummaries({ ids: ['a1', 'a1'], live: false }).map((a) => a.id)).toEqual(['a1'])
    expect(storage.assistantActivitySummaries({ ids: ['a1'], live: true }).map((a) => a.id)).toEqual(['a2', 'a1'])
    expect(storage.assistantActivitySummaries({ ids: [], live: false })).toEqual([])
  })

  it('keeps an approval card on its message and lists the audit log newest first', () => {
    const approval = { id: 'ap1', title: 'Browser Use · Access https://x.com', detail: 'Allow?', icon: 'globe' as const, activityId: 'a1' }
    storage.assistantMessageUpsert({ id: 'card', role: 'assistant', text: '', createdAt: 100, approval })
    storage.assistantMessageUpsert({ id: 'card', role: 'assistant', text: '', createdAt: 100, approval: { ...approval, decision: 'denied' } })
    expect(storage.assistantMessageList({ limit: 1 })[0].approval).toEqual({ ...approval, decision: 'denied' })

    storage.assistantAuditInsert({ id: 'r1', title: 'A', detail: 'd', icon: 'globe', decision: 'auto_allowed', at: 1, args: { origin: 'x' } })
    storage.assistantAuditInsert({ id: 'r2', title: 'B', detail: 'd', icon: 'app', decision: 'denied', at: 2, activityId: 'a1' })
    expect(storage.assistantAuditList(10)).toEqual([
      { id: 'r2', title: 'B', detail: 'd', icon: 'app', decision: 'denied', at: 2, activityId: 'a1' },
      { id: 'r1', title: 'A', detail: 'd', icon: 'globe', decision: 'auto_allowed', at: 1, args: { origin: 'x' } },
    ])
  })

  it('reads the thread for memory extraction: what was said and what tasks produced, by time', () => {
    // The thread from the first test (t1–t5 at 10–50), plus a card and two tasks.
    storage.assistantMessageUpsert({ id: 'card', role: 'assistant', text: '', createdAt: 25, approval: { id: 'x', title: 't', detail: 'd', icon: 'globe' } })
    const base = { taskId: 'aw', summary: 's', steps: [], startedAt: 1 }
    storage.assistantActivityUpsert({ ...base, id: 'done', title: '查票', status: 'done', report: 'G7 9:00', finishedAt: 35 })
    storage.assistantActivityUpsert({ ...base, id: 'stopped', title: 'x', status: 'stopped', finishedAt: 36 })
    const entries = storage.listAssistantTranscript({ after: 10, before: 40, limit: 10 })
    expect(entries.map((e) => [e.at, e.role, e.text])).toEqual([
      [20, 'assistant', 't2'],
      [30, 'user', 't3'],
      [35, 'assistant', '[Task "查票" — done] G7 9:00'],
      [40, 'assistant', 't4'],
    ])
    expect(storage.getAssistantExtractedUntil()).toBeNull()
    storage.setAssistantExtractedUntil(40)
    expect(storage.getAssistantExtractedUntil()).toBe(40)
  })
})
