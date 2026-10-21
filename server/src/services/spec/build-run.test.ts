import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpecRun, SpecTicket, SpecTicketBuild } from '../../types/spec.js'
import type { Task } from '../../types/task.js'

/** What the next ticket reviewer answers; tests set it per case. */
const review: { verdict: 'pass' | 'changes'; issues: unknown[]; rulings: string[]; designBroken: string } = {
  verdict: 'pass',
  issues: [],
  rulings: [],
  designBroken: '',
}
const prompts: string[] = []

vi.mock('../workflow/dispatch.js', () => ({
  runProviderAgent: vi.fn(async ({ prompt }: { prompt: string }) => {
    prompts.push(prompt)
    return JSON.stringify(review)
  }),
}))
vi.mock('operon-agents', () => ({
  LocalEnvironment: class {},
  createWorktree: vi.fn(async () => null),
  newAgentId: (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`,
  validateValue: (schema: { required?: string[] }, value: unknown) =>
    value && typeof value === 'object' && (schema.required ?? []).every((k) => k in (value as object))
      ? { ok: true }
      : { ok: false, error: 'missing keys' },
}))
const git = vi.hoisted(() => ({ head: 'head1' }))
vi.mock('../git.js', () => ({
  commit: vi.fn(async () => ''),
  excludeLocally: vi.fn(async () => undefined),
  getHeadSha: vi.fn(async () => git.head),
  getMergeBase: vi.fn(async () => 'base0'),
  getFileDiffRange: vi.fn(async (_repo: string, _file: unknown, base: string, head: string) => `diff ${base}..${head}`),
  getDiffStatText: vi.fn(async () => ' a.ts | 2 +-'),
}))
vi.mock('../workflow/store.js', () => ({
  appendEvent: vi.fn(),
  markExecuting: vi.fn(),
  unmarkExecuting: vi.fn(),
  readRunView: vi.fn(() => ({ runId: 'spec-1', agents: [{ index: 0 }, { index: 1 }] })),
}))
vi.mock('../workflow/registry.js', () => ({ registerWorkflowAbort: vi.fn(), unregisterWorkflowAbort: vi.fn() }))
vi.mock('../task-events.js', () => ({ broadcastTask: vi.fn() }))
vi.mock('../workflow/completion.js', () => ({ deliverWorkflowResult: vi.fn() }))
const orchestrator = vi.hoisted(() => ({
  dispatchProjectTask: vi.fn(async () => undefined),
  landSpecTicket: vi.fn(async () => ({ ok: true }) as { ok: boolean; reason?: string }),
  wakeTaskBinding: vi.fn(async () => true),
}))
vi.mock('../channel/agent-orchestrator.js', () => orchestrator)
// Never let a test reach the phone push relay.
const notify = vi.hoisted(() => vi.fn())
vi.mock('../notification-service.js', () => ({ notify }))
vi.mock('./spec-service.js', () => ({ specDesignChanged: vi.fn(async () => false) }))
const reviewRun = vi.hoisted(() => ({ onAllTicketsMerged: vi.fn() }))
vi.mock('./review-run.js', () => reviewRun)

const { frontier, onTicketInReview, onTicketLanded, onTicketTurnEnded, resumeBuild, isBuildActive, MAX_REVIEW_ROUNDS } =
  await import('./build-run.js')

// ---- Fixture: spec #7 with tickets T1 → T2, T3 independent ------------------

let dir: string

function entry(key: string, taskId: number, state: SpecTicketBuild['state']): SpecTicketBuild {
  return { key, taskId, implementer: 'codex', reviewer: 'claude-code', rounds: 0, state }
}

function makeStorage() {
  const spec = { id: 1, number: 7, projectId: 1, title: 'Snooze', workspaceId: 9, branchName: 'operon/task-7', sourceChatId: 42, status: 'in_progress' } as Task
  const tasks = new Map<number, Task>([
    [101, { id: 101, number: 8, parentTaskId: 1, status: 'in_review', blockedBy: [], workspaceId: 11, bindingId: 5, assignedAgentId: 50 } as unknown as Task],
    [102, { id: 102, number: 9, parentTaskId: 1, status: 'todo', blockedBy: [101], assignedAgentId: 50 } as unknown as Task],
    [103, { id: 103, number: 10, parentTaskId: 1, status: 'todo', blockedBy: [], assignedAgentId: 50 } as unknown as Task],
  ])
  let run: SpecRun = {
    taskId: 1,
    stage: 'building',
    config: {
      lead: { providerId: 'claude-code' },
      explorer: { providerId: 'codex' },
      candidates: [{ providerId: 'claude-code' }, { providerId: 'codex' }],
      judge: { providerId: 'claude-code' },
      builder: { providerId: 'claude-code' },
      concurrency: 1,
    },
    designSha: 'signed',
    workflowRunId: 'spec-1',
    runIds: ['spec-1'],
    build: [entry('T1', 101, 'reviewing'), entry('T2', 102, 'waiting'), entry('T3', 103, 'waiting')],
    rulings: [],
    error: null,
    createdAt: 0,
    updatedAt: 0,
  }
  const activity: { taskId: number; body: string; kind: string; actorType: string }[] = []
  const storage = {
    taskGet: (id: number) => (id === 1 ? spec : tasks.get(id) ?? null),
    taskUpdate: (id: number, patch: Partial<Task>) => {
      const t = id === 1 ? spec : tasks.get(id)
      if (t) Object.assign(t, patch)
      return t ?? null
    },
    taskListChildren: () => [...tasks.values()],
    taskListActivity: (taskId: number) => activity.filter((a) => a.taskId === taskId),
    taskAppendActivity: (taskId: number, a: { body: string; kind: string; actorType: string }) => activity.push({ taskId, ...a }),
    specRunGet: () => run,
    specRunUpdate: (_: number, patch: Partial<SpecRun>) => (run = { ...run, ...patch }),
    specRunList: () => [run],
    getWorkspace: (id: number) => ({ id, worktreePath: id === 9 ? dir : path.join(dir, 'ticket') }),
  }
  return { storage: storage as never, spec, tasks, run: () => run, activity }
}

const ticket = (key: string, blockedBy: string[] = []): SpecTicket => ({
  key, title: key, delivers: `${key} works`, acceptance: [`${key} accepted`], blockedBy, interfaces: [],
})

async function settled() {
  await vi.waitFor(() => expect(isBuildActive(1)).toBe(false))
  // Let the settle step after the session closes run too.
  await new Promise((r) => setTimeout(r, 10))
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spec-build-'))
  const specDir = path.join(dir, '.operon/changes/task-7')
  await fs.mkdir(specDir, { recursive: true })
  await fs.writeFile(path.join(specDir, 'design.md'), '## Intent\nsnooze')
  await fs.writeFile(path.join(specDir, 'tickets.json'), JSON.stringify([ticket('T1'), ticket('T2', ['T1']), ticket('T3')]))
  Object.assign(review, { verdict: 'pass', issues: [], rulings: [], designBroken: '' })
  git.head = 'head1'
  prompts.length = 0
  vi.clearAllMocks()
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('frontier', () => {
  const tasks = (entries: [number, Task['status'], number[]][]) =>
    new Map(entries.map(([id, status, blockedBy]) => [id, { status, blockedBy }] as const))

  it('starts waiting tickets whose blockers are done, up to the free slots', () => {
    const build = [entry('T1', 1, 'merged'), entry('T2', 2, 'waiting'), entry('T3', 3, 'waiting'), entry('T4', 4, 'waiting')]
    const t = tasks([[1, 'done', []], [2, 'todo', [1]], [3, 'todo', []], [4, 'todo', [3]]])
    expect(frontier(build, t, 3).map((b) => b.key)).toEqual(['T2', 'T3'])
    expect(frontier(build, t, 1).map((b) => b.key)).toEqual(['T2'])
  })

  it('counts building and reviewing tickets against the limit, but not blocked ones', () => {
    const build = [entry('T1', 1, 'reviewing'), entry('T2', 2, 'blocked'), entry('T3', 3, 'waiting')]
    const t = tasks([[1, 'in_review', []], [2, 'in_review', []], [3, 'todo', []]])
    expect(frontier(build, t, 1)).toEqual([])
    expect(frontier(build, t, 2).map((b) => b.key)).toEqual(['T3'])
  })

  it('leaves a ticket someone already started by hand alone', () => {
    const build = [entry('T1', 1, 'waiting')]
    expect(frontier(build, tasks([[1, 'in_progress', []]]), 3)).toEqual([])
  })
})

describe('ticket review', () => {
  it('merges a ticket that passes, keeping its rulings', async () => {
    const { storage, run } = makeStorage()
    review.rulings = ['Ruling: kept the old name, because the API is public']
    review.issues = [{ severity: 'minor', where: 'a.ts:3', issue: 'rename x' }]
    onTicketInReview(storage, 101)
    await settled()

    expect(orchestrator.landSpecTicket).toHaveBeenCalledWith(101, expect.objectContaining({ type: 'agent' }))
    expect(run().rulings).toEqual([{ ticketKey: 'T1', ruling: 'Ruling: kept the old name, because the API is public' }])
    expect(run().build[0].reviewedSha).toBe('head1')
    // The review read the ticket, the design and the full diff against the change branch.
    expect(prompts[0]).toContain('T1 accepted')
    expect(prompts[0]).toContain('diff base0..head1')
    expect(orchestrator.wakeTaskBinding).not.toHaveBeenCalled()
  })

  it('sends blocking issues back to the same implementer session and re-reviews only the fix', async () => {
    const { storage, run, tasks } = makeStorage()
    review.verdict = 'changes'
    review.issues = [{ severity: 'important', where: 'a.ts:9', issue: 'error is swallowed' }]
    onTicketInReview(storage, 101)
    await settled()

    expect(run().build[0]).toMatchObject({ state: 'building', rounds: 1, openIssues: ['[important] a.ts:9 — error is swallowed'] })
    expect(tasks.get(101)?.status).toBe('in_progress')
    expect(orchestrator.wakeTaskBinding).toHaveBeenCalledWith(5, expect.stringContaining('error is swallowed'))
    expect(orchestrator.landSpecTicket).not.toHaveBeenCalled()

    // The implementer fixes it and moves the ticket back to review.
    git.head = 'head2'
    tasks.get(101)!.status = 'in_review'
    Object.assign(review, { verdict: 'pass', issues: [] })
    onTicketInReview(storage, 101)
    await settled()

    expect(prompts[1]).toContain('This is a re-review')
    expect(prompts[1]).toContain('error is swallowed')
    expect(prompts[1]).toContain('diff head1..head2')
    expect(orchestrator.landSpecTicket).toHaveBeenCalledTimes(1)
  })

  it(`blocks a ticket after ${MAX_REVIEW_ROUNDS} failed rounds and gives its slot to the next ticket`, async () => {
    const { storage, run, tasks } = makeStorage()
    review.verdict = 'changes'
    review.issues = [{ severity: 'critical', where: 'a.ts:1', issue: 'wrong table' }]
    for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
      git.head = `head${round}`
      tasks.get(101)!.status = 'in_review'
      onTicketInReview(storage, 101)
      await settled()
    }
    expect(run().build[0]).toMatchObject({ state: 'blocked', rounds: MAX_REVIEW_ROUNDS })
    expect(notify).toHaveBeenCalledWith(storage, expect.objectContaining({ kind: 'spec_blocked', sourceKey: 'spec:1' }))
    // T2 waits on T1; T3 does not, and takes the freed slot (concurrency 1).
    expect(orchestrator.dispatchProjectTask).toHaveBeenCalledWith(103, 50)
    expect(orchestrator.dispatchProjectTask).not.toHaveBeenCalledWith(102, expect.anything())
  })

  it('pauses the spec when the review finds the design itself does not hold', async () => {
    const { storage, run } = makeStorage()
    review.designBroken = 'The design stores snoozes in a table the ticket cannot reach'
    onTicketInReview(storage, 101)
    await settled()
    expect(run().stage).toBe('stopped')
    expect(run().error).toContain('cannot reach')
    expect(run().build[0].state).toBe('blocked')
    expect(orchestrator.landSpecTicket).not.toHaveBeenCalled()
  })

  it('waits while the spec is paused, and reviews on resume', async () => {
    const { storage, run } = makeStorage()
    ;(storage as { specRunUpdate: (id: number, p: Partial<SpecRun>) => void }).specRunUpdate(1, { stage: 'stopped' })
    onTicketInReview(storage, 101)
    expect(prompts).toHaveLength(0)

    await resumeBuild(storage, 1)
    await settled()
    expect(run().stage).toBe('building')
    expect(orchestrator.landSpecTicket).toHaveBeenCalledWith(101, expect.anything())
  })
})

describe('landing', () => {
  it('starts what a merged ticket unblocked', async () => {
    const { storage, tasks, run } = makeStorage()
    tasks.get(101)!.status = 'done'
    await onTicketLanded(storage, 1, 101)
    expect(run().build[0].state).toBe('merged')
    // Concurrency 1: the first ticket of the frontier.
    expect(orchestrator.dispatchProjectTask).toHaveBeenCalledWith(102, 50)
    expect(run().build[1].state).toBe('building')
  })

  it('hands the change to the whole-change review once every ticket is merged', async () => {
    const { storage, tasks } = makeStorage()
    for (const t of tasks.values()) t.status = 'done'
    await onTicketLanded(storage, 1, 103)
    expect(reviewRun.onAllTicketsMerged).toHaveBeenCalledWith(storage, 1)
    expect(orchestrator.dispatchProjectTask).not.toHaveBeenCalled()
  })
})

describe('a turn that ends without handing the ticket in', () => {
  const building = () => {
    const fixture = makeStorage()
    fixture.tasks.get(101)!.status = 'in_progress'
    ;(fixture.storage as { specRunUpdate: (id: number, p: Partial<SpecRun>) => void }).specRunUpdate(1, {
      build: [entry('T1', 101, 'building'), entry('T2', 102, 'waiting'), entry('T3', 103, 'waiting')],
    })
    return fixture
  }

  it('gets one reminder, then blocks the ticket', async () => {
    const { storage, run } = building()
    await onTicketTurnEnded(storage, 101)
    expect(orchestrator.wakeTaskBinding).toHaveBeenCalledWith(5, expect.stringContaining('still in progress'))
    expect(run().build[0]).toMatchObject({ state: 'building', nudged: true })

    await onTicketTurnEnded(storage, 101)
    expect(run().build[0].state).toBe('blocked')
    expect(orchestrator.wakeTaskBinding).toHaveBeenCalledTimes(1)
  })

  it('blocks at once when the session failed', async () => {
    const { storage, run } = building()
    await onTicketTurnEnded(storage, 101, 'No models are available')
    expect(run().build[0]).toMatchObject({ state: 'blocked', blockedReason: 'Its session failed: No models are available' })
    expect(notify).toHaveBeenCalledWith(storage, expect.objectContaining({ kind: 'spec_blocked' }))
  })

  it('leaves a ticket that was handed in alone', async () => {
    const { storage, run, tasks } = building()
    tasks.get(101)!.status = 'in_review'
    await onTicketTurnEnded(storage, 101)
    expect(run().build[0].state).toBe('building')
    expect(orchestrator.wakeTaskBinding).not.toHaveBeenCalled()
  })
})
