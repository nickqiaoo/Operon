import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpecRun, SpecRunConfig, SpecTicket, SpecTicketBuild } from '../../types/spec.js'
import type { Task } from '../../types/task.js'

/** What each agent answers, by the prompt it gets. */
const replies = {
  branch: { findings: [] as unknown[], evidence: [{ criterion: 'T1.1', check: 'npm test', observed: 'green', result: 'PASS' }] },
  actOn: [] as unknown[],
}
const prompts: string[] = []
const reviewItem = { title: 'Swallowed error', where: 'a.ts:9', detail: 'the catch drops it', highConfidence: true, raisedBy: ['codex', 'claude-code'] }

vi.mock('../workflow/dispatch.js', () => ({
  runProviderAgent: vi.fn(async ({ prompt }: { prompt: string }) => {
    prompts.push(prompt)
    if (prompt.includes('adversarial reviewer of a finished change')) return JSON.stringify(replies.branch)
    const review = {
      actOn: prompt.includes('Check the fix only') ? [] : replies.actOn,
      consider: [],
      noted: [],
      dismissed: [],
      evidence: [{ criterion: 'T1.1', check: 'npm test', observed: 'green', result: 'PASS', by: 'codex' }],
      summary: 'Ready.',
    }
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
const git = vi.hoisted(() => ({ head: 'h1' }))
vi.mock('../git.js', () => ({
  commit: vi.fn(async () => ''),
  excludeLocally: vi.fn(async () => undefined),
  getCurrentBranch: vi.fn(async () => 'main'),
  getHeadSha: vi.fn(async () => git.head),
  getMergeBase: vi.fn(async () => 'base0'),
  getFileDiffRange: vi.fn(async (_r: string, _f: unknown, base: string, head: string) => `diff ${base}..${head}`),
  getDiffStatText: vi.fn(async () => ' a.ts | 2 +-'),
}))
vi.mock('../workflow/store.js', () => ({
  appendEvent: vi.fn(),
  markExecuting: vi.fn(),
  unmarkExecuting: vi.fn(),
  readRunView: vi.fn(() => ({ runId: 'spec-1', agents: [] })),
}))
vi.mock('../workflow/registry.js', () => ({ registerWorkflowAbort: vi.fn(), unregisterWorkflowAbort: vi.fn() }))
const delivered = vi.hoisted(() => [] as unknown[])
vi.mock('../workflow/completion.js', () => ({ deliverWorkflowResult: vi.fn(async (v: unknown) => delivered.push(v)) }))
vi.mock('../task-events.js', () => ({ broadcastTask: vi.fn() }))
const orchestrator = vi.hoisted(() => ({
  dispatchProjectTask: vi.fn(async () => undefined),
  landSpecTicket: vi.fn(),
  wakeTaskBinding: vi.fn(async () => true),
}))
vi.mock('../channel/agent-orchestrator.js', () => orchestrator)
// Never let a test reach the phone push relay.
const notify = vi.hoisted(() => vi.fn())
vi.mock('../notification-service.js', () => ({ notify }))
vi.mock('./spec-service.js', () => ({ specDesignChanged: vi.fn(async () => false) }))

const { branchReviewers, onAllTicketsMerged, isReviewActive, requestSignoffChanges } = await import('./review-run.js')
const { readSpecFile, readSpecJson } = await import('./files.js')

// ---- Fixture: spec #7, ticket T1 merged -------------------------------------

const config: SpecRunConfig = {
  lead: { providerId: 'claude-code' },
  explorer: { providerId: 'codex' },
  candidates: [{ providerId: 'claude-code' }, { providerId: 'codex' }],
  judge: { providerId: 'codex' },
  builder: { providerId: 'codex' },
}
let dir: string

function makeStorage() {
  const spec = { id: 1, number: 7, projectId: 1, title: 'Snooze', workspaceId: 9, branchName: 'operon/task-7', sourceChatId: 42, status: 'in_progress' } as Task
  const tasks = new Map<number, Task>([[101, { id: 101, number: 8, parentTaskId: 1, status: 'done', blockedBy: [] } as unknown as Task]])
  const merged: SpecTicketBuild = { key: 'T1', taskId: 101, implementer: 'codex', reviewer: 'claude-code', rounds: 0, state: 'merged' }
  let run: SpecRun = {
    taskId: 1, stage: 'building', config, designSha: 'signed', workflowRunId: 'spec-1', runIds: ['spec-1'],
    build: [merged], rulings: [], error: null, createdAt: 0, updatedAt: 0,
  }
  const storage = {
    taskGet: (id: number) => (id === 1 ? spec : tasks.get(id) ?? null),
    taskUpdate: (id: number, patch: Partial<Task>) => Object.assign(id === 1 ? spec : (tasks.get(id) as Task), patch),
    taskCreate: (input: Partial<Task>) => {
      const child = { id: 200 + tasks.size, number: 20 + tasks.size, status: 'todo', blockedBy: [], ...input } as Task
      tasks.set(child.id, child)
      return child
    },
    taskListChildren: () => [...tasks.values()],
    taskListActivity: () => [],
    taskAppendActivity: vi.fn(),
    specRunGet: () => run,
    specRunUpdate: (_: number, patch: Partial<SpecRun>) => (run = { ...run, ...patch }),
    getWorkspace: (id: number) => ({ id, worktreePath: dir }),
    getProject: () => ({ id: 1, rootPath: dir }),
    getAgentByName: () => ({ id: 50, name: 'Spec builder · codex' }),
    createAgent: vi.fn(),
  }
  return { storage: storage as never, spec, tasks, run: () => run }
}

const loc = () => ({ taskId: 1, taskNumber: 7, worktreePath: dir })
const ticket: SpecTicket = { key: 'T1', title: 'storage', delivers: 'd', acceptance: ['snoozes persist'], blockedBy: [], interfaces: [] }

async function settled() {
  await vi.waitFor(() => expect(isReviewActive(1)).toBe(false))
  await new Promise((r) => setTimeout(r, 10))
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spec-review-'))
  const specDir = path.join(dir, '.operon/changes/task-7')
  await fs.mkdir(specDir, { recursive: true })
  await fs.writeFile(path.join(specDir, 'brief.md'), '## Intent\nsnooze')
  await fs.writeFile(path.join(specDir, 'design.md'), '## Intent\ndesign')
  await fs.writeFile(path.join(specDir, 'tickets.json'), JSON.stringify([ticket]))
  replies.actOn = []
  git.head = 'h1'
  prompts.length = 0
  delivered.length = 0
  vi.clearAllMocks()
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('branchReviewers', () => {
  it('takes two reviewers from different families', () => {
    expect(branchReviewers(config)).toEqual(['codex', 'claude-code'])
  })
  it('takes one when the spec has only one family', () => {
    const one = { ...config, lead: { providerId: 'codex' }, candidates: [{ providerId: 'codex' }, { providerId: 'codex' }] }
    expect(branchReviewers(one)).toEqual(['codex'])
  })
})

describe('the whole-change review', () => {
  it('reviews with two families, consolidates, and waits for sign-off', async () => {
    const { storage, run, spec } = makeStorage()
    onAllTicketsMerged(storage, 1)
    await settled()

    const reviews = prompts.filter((p) => p.includes('adversarial reviewer of a finished change'))
    expect(reviews).toHaveLength(2)
    expect(reviews[0]).toContain('T1.1 snoozes persist')
    expect(reviews[0]).toContain('diff base0..h1')
    expect(prompts.some((p) => p.includes('Merge what they found into one verdict'))).toBe(true)

    expect(run().stage).toBe('awaiting_signoff')
    expect(spec.status).toBe('in_review')
    const review = await readSpecFile(loc(), 'review.md')
    expect(review).toContain('## Acceptance evidence')
    expect(review).toContain('| T1.1 | PASS |')
    expect(notify).toHaveBeenCalledWith(storage, expect.objectContaining({ kind: 'spec_gate', sourceKey: 'spec:1' }))
    // Gate 2 is reported back to the chat.
    expect(delivered).toHaveLength(1)
  })

  it('sends act-on items through one fix ticket, then re-checks only the fix', async () => {
    const { storage, run, tasks } = makeStorage()
    replies.actOn = [reviewItem]
    onAllTicketsMerged(storage, 1)
    await settled()

    expect(run().stage).toBe('building')
    const fix = run().build.find((b) => b.key === 'R1')
    expect(fix).toMatchObject({ implementer: 'codex', state: 'building' })
    expect(orchestrator.dispatchProjectTask).toHaveBeenCalledWith(fix!.taskId, 50)
    expect((await readSpecJson<SpecTicket[]>(loc(), 'tickets.json'))?.map((t) => t.key)).toEqual(['T1', 'R1'])
    expect(await readSpecFile(loc(), 'review.md')).toBeNull()
    expect(delivered).toHaveLength(0)

    // The fix lands; everything is merged again.
    tasks.get(fix!.taskId)!.status = 'done'
    git.head = 'h2'
    prompts.length = 0
    onAllTicketsMerged(storage, 1)
    await settled()

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Check the fix only')
    expect(prompts[0]).toContain('diff h1..h2')
    expect(run().stage).toBe('awaiting_signoff')
    expect(await readSpecFile(loc(), 'review.md')).toContain('1 act-on item(s) were fixed')
  })

  it('turns changes requested at gate 2 into a ticket and reviews the change again afterwards', async () => {
    const { storage, spec, run } = makeStorage()
    onAllTicketsMerged(storage, 1)
    await settled()

    const child = await requestSignoffChanges(storage, spec, 'Use the brand colour')
    expect(child.title).toBe('Changes requested')
    expect(run().stage).toBe('building')
    expect(run().build.at(-1)).toMatchObject({ key: 'C1', taskId: child.id })
    expect(await readSpecFile(loc(), 'review.md')).toBeNull()
    expect(await readSpecFile(loc(), 'reviews/codex.json')).toBeNull()
  })
})
