import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpecRun, SpecRunConfig, SpecTicket } from '../../types/spec.js'
import type { Task } from '../../types/task.js'

// ---- Fakes for everything outside the stage machine --------------------------

/** What each fake agent replies, chosen by the prompt it was given. */
const replies = {
  builder: 'nothing important left',
  triageQuestions: [] as { question: string; why: string }[],
  synthesisVerdict: 'synthesized' as 'synthesized' | 'diverged',
  failCandidates: 0,
}
const prompts: string[] = []

vi.mock('../workflow/dispatch.js', () => ({
  runProviderAgent: vi.fn(async ({ prompt }: { prompt: string }) => {
    prompts.push(prompt)
    if (prompt.includes('You are one of several explorers')) return 'explorer findings'
    if (prompt.includes('Merge their findings')) return '## Overview\ngrounding'
    if (prompt.includes('write the rubric')) return JSON.stringify({ criteria: ['a', 'b', 'c'] })
    if (prompt.includes('ONE candidate design')) {
      if (replies.failCandidates > 0) {
        replies.failCandidates--
        throw new Error('provider down')
      }
      return '## Problem\ncandidate'
    }
    if (prompt.includes('read-only judge')) return '## Recommendation\nA'
    if (prompt.includes('Several candidates designed the same change')) {
      return JSON.stringify({
        verdict: replies.synthesisVerdict,
        base: 'A',
        design: '## Intent\ndesign v1',
        synthesis: '## Base\nA',
        underspecified: replies.synthesisVerdict === 'diverged' ? ['Which way?'] : [],
      })
    }
    if (prompt.includes('asked to plan how to build it')) return replies.builder
    if (prompt.includes('Sort every question')) {
      return JSON.stringify({
        design: '## Intent\ndesign v2',
        calls: [{ question: 'retry count?', decision: '3' }],
        questions: replies.triageQuestions,
      })
    }
    if (prompt.includes('they answered')) {
      return JSON.stringify({ design: '## Intent\ndesign v3', calls: [] })
    }
    if (prompt.includes('Break the design below into tickets')) {
      const tickets: SpecTicket[] = [
        { key: 'T1', title: 'storage', delivers: 'd', acceptance: ['x'], blockedBy: [], interfaces: [] },
        { key: 'T2', title: 'ui', delivers: 'd', acceptance: ['y'], blockedBy: ['T1'], interfaces: [] },
      ]
      return JSON.stringify({ tickets })
    }
    throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`)
  }),
}))
vi.mock('operon-agents', () => ({
  LocalEnvironment: class {},
  createWorktree: vi.fn(async () => null),
  newAgentId: (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`,
  // Enough of a validator for these schemas: required keys present.
  validateValue: (schema: { required?: string[] }, value: unknown) =>
    value && typeof value === 'object' && (schema.required ?? []).every((k) => k in (value as object))
      ? { ok: true }
      : { ok: false, error: 'missing keys' },
}))
vi.mock('../git.js', () => ({ commit: vi.fn(async () => 'sha'), excludeLocally: vi.fn(async () => undefined) }))
// Hoisted with the mock below, which runs before any other line of this file.
const { appendEventMock } = vi.hoisted(() => ({
  appendEventMock: vi.fn((_runId: string, _event: { kind: string }) => undefined),
}))
vi.mock('../workflow/store.js', () => ({
  appendEvent: appendEventMock,
  appendEvents: vi.fn(),
  markExecuting: vi.fn(),
  unmarkExecuting: vi.fn(),
  // One agent per run, a second long, so a spec's history can be counted.
  readRunView: vi.fn((runId: string) => ({
    runId,
    status: 'completed',
    startedAt: 0,
    endedAt: 1000,
    agents: [
      { index: 0, label: 'candidate A', state: 'done', startedAt: 0, endedAt: 600 },
      { index: 1, label: 'candidate B', state: 'done', startedAt: 100, endedAt: 1000 },
      { index: 2, label: 'judge', state: 'done', startedAt: 5000, endedAt: 5500 },
    ],
  })),
}))
const delivered: unknown[] = []
vi.mock('../workflow/completion.js', () => ({ deliverWorkflowResult: vi.fn(async (v: unknown) => delivered.push(v)) }))
vi.mock('../task-events.js', () => ({ broadcastTask: vi.fn() }))
// The build stage starts tickets through the orchestrator; these tests stop at gate 1.
const { dispatchMock } = vi.hoisted(() => ({ dispatchMock: vi.fn(async () => undefined) }))
vi.mock('../channel/agent-orchestrator.js', () => ({
  dispatchProjectTask: dispatchMock,
  landSpecTicket: vi.fn(),
  wakeTaskBinding: vi.fn(),
}))
// Never let a test reach the phone push relay.
vi.mock('../notification-service.js', () => ({ notify: vi.fn() }))

const { startDesignRun, isDesignRunActive, validateTickets } = await import('./design-run.js')
const { answerSpecQuestions, approveSpecDesign, getSpecView, reapproveSpecDesign, requestSpecChanges, specDesignChanged } =
  await import('./spec-service.js')
const { readSpecFile, readSpecJson } = await import('./files.js')

// ---- A minimal in-memory storage --------------------------------------------

const config: SpecRunConfig = {
  lead: { providerId: 'claude-code' },
  explorer: { providerId: 'grok' },
  candidates: [{ providerId: 'claude-code' }, { providerId: 'codex' }],
  judge: { providerId: 'grok' },
  builder: { providerId: 'codex' },
}

function makeStorage(worktreePath: string) {
  const task = { id: 1, number: 7, projectId: 1, title: 'Snooze', workspaceId: 9, sourceChatId: 42 } as Task
  let run: SpecRun = {
    taskId: 1, stage: 'grounding', config, designSha: null, workflowRunId: null, runIds: [], build: [], rulings: [], error: null, proposal: null, createdAt: 0, updatedAt: 0,
  }
  const created: Task[] = []
  const storage = {
    taskGet: (id: number) => (id === 1 ? task : created.find((t) => t.id === id) ?? null),
    specRunGet: () => run,
    specRunUpdate: (_: number, patch: Partial<SpecRun>) =>
      (run = {
        ...run,
        ...patch,
        // As the real store does: a new run joins the history.
        runIds:
          patch.workflowRunId && !run.runIds.includes(patch.workflowRunId)
            ? [...run.runIds, patch.workflowRunId]
            : run.runIds,
      }),
    getWorkspace: () => ({ id: 9, worktreePath }),
    taskAppendActivity: vi.fn(),
    taskListChildren: () => created,
    taskCreate: (input: { title: string; blockedBy?: number[] }) => {
      const child = { id: 100 + created.length, number: 8 + created.length, status: 'todo', ...input } as unknown as Task
      created.push(child)
      return child
    },
    taskUpdate: (id: number, patch: Partial<Task>) => {
      const child = created.find((t) => t.id === id)
      if (child) Object.assign(child, patch)
      return child ?? null
    },
    getAgentByName: (name: string) => agents.find((a) => a.name === name) ?? null,
    createAgent: (input: { name: string; provider: string; permissionMode?: string }) => {
      const agent = { id: 50 + agents.length, ...input }
      agents.push(agent)
      return agent
    },
  }
  const agents: { id: number; name: string; provider: string; permissionMode?: string }[] = []
  return { storage: storage as never, task, run: () => run, created }
}

async function settle(taskId: number) {
  await vi.waitFor(() => expect(isDesignRunActive(taskId)).toBe(false), { timeout: 2000 })
}

let dir: string
const loc = () => ({ taskId: 1, taskNumber: 7, worktreePath: dir })

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spec-run-'))
  await fs.mkdir(path.join(dir, '.operon/changes/task-7'), { recursive: true })
  await fs.writeFile(path.join(dir, '.operon/changes/task-7/brief.md'), '## Intent\nsnooze')
  Object.assign(replies, { builder: 'nothing important left', triageQuestions: [], synthesisVerdict: 'synthesized', failCandidates: 0 })
  prompts.length = 0
  delivered.length = 0
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('the design stage', () => {
  it('runs straight through to a design waiting for approval', async () => {
    const { storage, task, run } = makeStorage(dir)
    startDesignRun({ storage, task, run: run(), loc: loc(), chatId: 42 })
    await settle(1)

    expect(run().stage).toBe('awaiting_design')
    expect(await readSpecFile(loc(), 'grounding.md')).toContain('grounding')
    expect(await readSpecFile(loc(), 'candidates/A.md')).toContain('candidate')
    expect(await readSpecFile(loc(), 'candidates/B.md')).toContain('candidate')
    expect(await readSpecFile(loc(), 'design.md')).toBe('## Intent\ndesign v1')
    expect((await readSpecJson<SpecTicket[]>(loc(), 'tickets.json'))?.map((t) => t.key)).toEqual(['T1', 'T2'])
    // The chat is told, so its agent can present the design.
    expect(delivered).toHaveLength(1)
    // Candidates never see the rubric.
    expect(prompts.filter((p) => p.includes('ONE candidate design')).some((p) => p.includes('## Rubric'))).toBe(false)
  })

  it('stops for the user\'s answers, then folds them in and finishes', async () => {
    replies.builder = '1. How many retries?'
    replies.triageQuestions = [{ question: 'Wake early on new messages?', why: 'changes the scheduler' }]
    const { storage, task, run } = makeStorage(dir)
    startDesignRun({ storage, task, run: run(), loc: loc(), chatId: 42 })
    await settle(1)

    expect(run().stage).toBe('awaiting_answers')
    expect(await readSpecFile(loc(), 'synthesis.md')).toContain('## Calls I made for you')
    expect(await readSpecFile(loc(), 'tickets.json')).toBeNull()

    await answerSpecQuestions(storage, 1, 'Yes, wake early.')
    await settle(1)

    expect(run().stage).toBe('awaiting_design')
    expect(await readSpecFile(loc(), 'design.md')).toBe('## Intent\ndesign v3')
    expect(await readSpecFile(loc(), 'questions.json')).toBeNull()
    expect(prompts.some((p) => p.includes('they answered') && p.includes('Yes, wake early.'))).toBe(true)
    // Nothing upstream ran twice: one builder check, two candidates.
    expect(prompts.filter((p) => p.includes('asked to plan how to build it'))).toHaveLength(1)
    expect(prompts.filter((p) => p.includes('ONE candidate design'))).toHaveLength(2)
  })

  it('asks the user instead of averaging candidates that diverged', async () => {
    replies.synthesisVerdict = 'diverged'
    const { storage, task, run } = makeStorage(dir)
    startDesignRun({ storage, task, run: run(), loc: loc(), chatId: 42 })
    await settle(1)

    expect(run().stage).toBe('awaiting_answers')
    expect(await readSpecFile(loc(), 'design.md')).toBeNull()

    replies.synthesisVerdict = 'synthesized'
    await answerSpecQuestions(storage, 1, 'Go with the table.')
    await settle(1)

    expect(run().stage).toBe('awaiting_design')
    const syntheses = prompts.filter((p) => p.includes('Several candidates designed the same change'))
    expect(syntheses.at(-1)).toContain('Go with the table.')
  })

  it('fails when fewer than two candidates finish, and resumes without redoing the finished one', async () => {
    replies.failCandidates = 1
    const { storage, task, run } = makeStorage(dir)
    startDesignRun({ storage, task, run: run(), loc: loc(), chatId: 42 })
    await settle(1)

    expect(run().stage).toBe('failed')
    expect(run().error).toMatch(/at least two/)

    startDesignRun({ storage, task, run: run(), loc: loc(), chatId: 42 })
    await settle(1)
    expect(run().stage).toBe('awaiting_design')
    // 2 attempts the first time (one failed) + only the missing one on resume.
    expect(prompts.filter((p) => p.includes('ONE candidate design'))).toHaveLength(3)
  })

  it('re-synthesizes with the user\'s feedback, keeping the candidates', async () => {
    const { storage, task, run } = makeStorage(dir)
    startDesignRun({ storage, task, run: run(), loc: loc(), chatId: 42 })
    await settle(1)

    await requestSpecChanges(storage, 1, { comment: 'No new table, please.' }, { type: 'human', id: null, name: 'You' })
    await settle(1)

    expect(run().stage).toBe('awaiting_design')
    expect(prompts.filter((p) => p.includes('ONE candidate design'))).toHaveLength(2)
    expect(prompts.filter((p) => p.includes('Several candidates designed the same change')).at(-1)).toContain(
      'No new table, please.',
    )

    // The redesign continued the spec's run instead of opening another.
    expect(run().runIds).toHaveLength(1)
    expect(appendEventMock.mock.calls.filter(([, e]) => e.kind === 'started').at(-1)?.[1]).toMatchObject({ resumed: true })
    // Working time: the two overlapping candidates once (0–1000), the judge after the gap (500).
    expect((await getSpecView(storage, 1)).elapsedMs).toBe(1500)
  })

  it('turns approved tickets into subtasks, blockers wired by id', async () => {
    const { storage, task, run, created } = makeStorage(dir)
    startDesignRun({ storage, task, run: run(), loc: loc(), chatId: 42 })
    await settle(1)

    dispatchMock.mockClear()
    await approveSpecDesign(storage, 1, { type: 'human', id: null, name: 'You' })

    expect(run().stage).toBe('building')
    expect(run().designSha).toMatch(/^[0-9a-f]{40}$/)
    expect(created.map((t) => t.title)).toEqual(['storage', 'ui'])
    expect(created[1].blockedBy).toEqual([created[0].id])
    // Every ticket gets the hidden builder of the implementer seat (codex here),
    // reviewed by another family; only the one without blockers starts.
    expect(created.map((t) => t.assignedAgentId)).toEqual([50, 50])
    expect(run().build.map((b) => [b.key, b.implementer, b.reviewer, b.state])).toEqual([
      ['T1', 'codex', 'grok', 'building'],
      ['T2', 'codex', 'grok', 'waiting'],
    ])
    expect(dispatchMock).toHaveBeenCalledTimes(1)
    expect(dispatchMock).toHaveBeenCalledWith(created[0].id, 50)
  })

  it('builds a ticket on the provider picked for it at gate 1', async () => {
    const { storage, task, run } = makeStorage(dir)
    startDesignRun({ storage, task, run: run(), loc: loc(), chatId: 42 })
    await settle(1)
    await approveSpecDesign(storage, 1, { type: 'human', id: null, name: 'You' }, { implementers: { T2: 'claude-code' } })
    expect(run().build.map((b) => [b.key, b.implementer, b.reviewer])).toEqual([
      ['T1', 'codex', 'grok'],
      ['T2', 'claude-code', 'grok'],
    ])
  })

  it('notices a design edited after approval and clears once it is re-approved', async () => {
    const { storage, task, run, created } = makeStorage(dir)
    startDesignRun({ storage, task, run: run(), loc: loc(), chatId: 42 })
    await settle(1)
    await approveSpecDesign(storage, 1, { type: 'human', id: null, name: 'You' })

    expect(await specDesignChanged(storage, 1)).toBe(false)
    const view = await getSpecView(storage, 1)
    expect(view.ticketTasks.T1?.number).toBe(created[0].number)
    expect(view.ticketTasks.T2?.number).toBe(created[1].number)

    await fs.appendFile(path.join(dir, '.operon/changes/task-7/design.md'), '\nA late edit.')
    expect(await specDesignChanged(storage, 1)).toBe(true)
    expect((await getSpecView(storage, 1)).designChanged).toBe(true)

    await reapproveSpecDesign(storage, 1, { type: 'human', id: null, name: 'You' })
    expect(await specDesignChanged(storage, 1)).toBe(false)
    expect(created).toHaveLength(2)
  })
})

describe('validateTickets', () => {
  const t = (key: string, blockedBy: string[] = []): SpecTicket => ({
    key, title: key, delivers: '', acceptance: ['x'], blockedBy, interfaces: [],
  })
  it('accepts a DAG', () => expect(validateTickets([t('T1'), t('T2', ['T1'])])).toBeNull())
  it('rejects unknown blockers', () => expect(validateTickets([t('T1', ['T9'])])).toMatch(/does not exist/))
  it('rejects cycles', () => expect(validateTickets([t('T1', ['T2']), t('T2', ['T1'])])).toMatch(/cycle/))
  it('rejects duplicate keys', () => expect(validateTickets([t('T1'), t('T1')])).toMatch(/duplicate/))
})
