import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBinding } from '../../types/agent-binding.js'
import type { SpecRun, SpecTicketBuild } from '../../types/spec.js'
import type { Task } from '../../types/task.js'

vi.mock('../workflow/dispatch.js', () => ({ runProviderAgent: vi.fn() }))
vi.mock('operon-agents', () => ({ LocalEnvironment: class {}, createWorktree: vi.fn(), newAgentId: () => 'a', validateValue: vi.fn() }))
vi.mock('../workflow/store.js', () => ({ appendEvent: vi.fn(), markExecuting: vi.fn(), unmarkExecuting: vi.fn(), readRunView: vi.fn() }))
vi.mock('../workflow/registry.js', () => ({ registerWorkflowAbort: vi.fn(), unregisterWorkflowAbort: vi.fn() }))
vi.mock('../workflow/completion.js', () => ({ deliverChatNotice: vi.fn(async () => true), deliverWorkflowResult: vi.fn() }))
vi.mock('../task-events.js', () => ({ broadcastTask: vi.fn() }))
const orchestrator = vi.hoisted(() => ({
  attachSpecCoordinator: vi.fn(),
  dispatchProjectTask: vi.fn(async () => undefined),
  landSpecTicket: vi.fn(),
  wakeTaskBinding: vi.fn(async () => true),
}))
vi.mock('../channel/agent-orchestrator.js', () => orchestrator)
const notify = vi.hoisted(() => vi.fn())
vi.mock('../notification-service.js', () => ({ notify }))
vi.mock('./spec-service.js', () => ({
  SpecError: class SpecError extends Error {},
  specDesignChanged: vi.fn(async () => false),
}))
const reviewRun = vi.hoisted(() => ({ onAllTicketsMerged: vi.fn() }))
vi.mock('./review-run.js', () => reviewRun)

const { escalate, integrationDone, isCoordinatorOf, onCoordinatorTurnEnded, retryTicket } = await import('./coordinator.js')
const { blockTicket } = await import('./build-run.js')
const { MAX_COORDINATOR_RETRIES } = await import('./prompts.js')

let root: string
let repo: string
let worktree: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

const COORDINATOR: AgentBinding = { id: 77, agentId: 60, scopeKind: 'task', scopeKey: '1', status: 'idle', workspaceId: 9 } as AgentBinding

function makeStorage(entries: SpecTicketBuild[] = [], stage: SpecRun['stage'] = 'building') {
  const spec = { id: 1, number: 7, projectId: 1, title: 'Snooze', workspaceId: 9, bindingId: 77, branchName: 'operon/task-7' } as Task
  const tasks = new Map<number, Task>([
    [101, { id: 101, number: 8, parentTaskId: 1, status: 'in_progress', workspaceId: 11, bindingId: 5, assignedAgentId: 50 } as unknown as Task],
  ])
  let run = {
    taskId: 1,
    stage,
    config: { lead: { providerId: 'claude-code' } },
    build: entries,
    rulings: [],
    error: null,
  } as unknown as SpecRun
  const activity: { taskId: number; body?: string }[] = []
  const artifacts: Record<string, string> = {}
  const storage = {
    specArtifactsRead: () => ({ ...artifacts }),
    specArtifactsWrite: (_taskId: number, files: Record<string, string | null>) => {
      for (const [file, content] of Object.entries(files)) {
        if (content === null) delete artifacts[file]
        else artifacts[file] = content
      }
    },
    taskGet: (id: number) => (id === 1 ? spec : tasks.get(id) ?? null),
    taskGetByNumber: (_p: number, n: number) => [spec, ...tasks.values()].find((t) => t.number === n) ?? null,
    taskUpdate: (id: number, patch: Partial<Task>) => Object.assign(id === 1 ? spec : (tasks.get(id) as Task), patch),
    taskAppendActivity: (taskId: number, a: { body?: string }) => activity.push({ taskId, ...a }),
    specRunGet: (id: number) => (id === 1 ? run : null),
    specRunUpdate: (_: number, patch: Partial<SpecRun>) => (run = { ...run, ...patch }),
    getWorkspace: (id: number) => ({ id, worktreePath: worktree }),
    getProject: () => ({ id: 1, rootPath: repo }),
    getBinding: (id: number) => (id === 77 ? COORDINATOR : null),
    getAgent: () => ({ id: 60, name: 'Spec coordinator · claude-code', provider: 'claude-code', model: '' }),
  }
  return { storage: storage as never, spec, tasks, run: () => run, activity }
}

const blocked = (patch: Partial<SpecTicketBuild> = {}): SpecTicketBuild => ({
  key: 'T1',
  taskId: 101,
  implementer: 'codex',
  reviewer: 'claude-code',
  rounds: 3,
  state: 'blocked',
  blockedReason: '3 review rounds did not pass',
  ...patch,
})

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'spec-coordinator-'))
  repo = path.join(root, 'repo')
  worktree = path.join(root, 'wt')
  await fs.mkdir(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  await fs.writeFile(path.join(repo, 'a.ts'), 'one\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  git(repo, 'worktree', 'add', '-q', '-b', 'operon/task-7', worktree)
  vi.clearAllMocks()
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('who the coordinator is', () => {
  it('is the agent of the spec\'s own binding', () => {
    const { storage, spec } = makeStorage()
    expect(isCoordinatorOf(storage, spec, 60)).toBe(true)
    expect(isCoordinatorOf(storage, spec, 50)).toBe(false)
  })
})

describe('a blocked ticket', () => {
  it('goes to the coordinator, not the user', async () => {
    const { storage, spec, run } = makeStorage([blocked({ state: 'building', blockedReason: undefined })])
    await blockTicket(storage, spec, 101, 'it stopped twice', 'Ticket #8 stopped')

    expect(orchestrator.wakeTaskBinding).toHaveBeenCalledWith(77, expect.stringContaining('Ticket #8 (T1) of spec #7 is blocked: it stopped twice'))
    expect(run().build[0]).toMatchObject({ state: 'blocked', coordinator: 'asked' })
    expect(notify).not.toHaveBeenCalled()
  })

  it('goes to the user once the coordinator has had its retries', async () => {
    const { storage, spec, run } = makeStorage([blocked({ state: 'building', retries: MAX_COORDINATOR_RETRIES })])
    await blockTicket(storage, spec, 101, 'it stopped twice', 'Ticket #8 stopped')

    expect(orchestrator.wakeTaskBinding).not.toHaveBeenCalled()
    expect(run().build[0].coordinator).toBeUndefined()
    expect(notify).toHaveBeenCalledWith(storage, expect.objectContaining({ kind: 'spec_blocked', body: 'Ticket #8 stopped' }))
  })

  it('goes to the user when the coordinator cannot be woken', async () => {
    const { storage, spec, run } = makeStorage([blocked({ state: 'building' })])
    orchestrator.wakeTaskBinding.mockResolvedValueOnce(false)
    await blockTicket(storage, spec, 101, 'it stopped twice', 'Ticket #8 stopped')

    expect(run().build[0].coordinator).toBeUndefined()
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('reaches the user when the coordinator\'s turn ends without acting on it', async () => {
    const { storage, run } = makeStorage([blocked({ coordinator: 'asked' })])
    await onCoordinatorTurnEnded(storage, 1)

    expect(run().build[0].coordinator).toBe('escalated')
    expect(notify).toHaveBeenCalledWith(storage, expect.objectContaining({ kind: 'spec_blocked', body: expect.stringContaining('#8') }))
    // Told once.
    await onCoordinatorTurnEnded(storage, 1)
    expect(notify).toHaveBeenCalledTimes(1)
  })
})

describe('spec_retry_ticket', () => {
  it('sets the ticket going in its implementer\'s session, rounds reset', async () => {
    const { storage, spec, run, tasks, activity } = makeStorage([blocked({ coordinator: 'asked', openIssues: ['x'] })])
    const text = await retryTicket(storage, spec, { ticket: 8, instructions: 'Use the existing scheduler.', ruling: 'scheduler owns timers' }, 'Coord')

    expect(text).toContain('building again')
    expect(run().build[0]).toMatchObject({ state: 'building', rounds: 0, retries: 1, openIssues: ['x'] })
    expect(run().build[0].coordinator).toBeUndefined()
    expect(run().rulings).toEqual([{ ticketKey: 'T1', ruling: 'scheduler owns timers' }])
    expect(tasks.get(101)?.status).toBe('in_progress')
    expect(orchestrator.wakeTaskBinding).toHaveBeenCalledWith(5, expect.stringContaining('Use the existing scheduler.'))
    expect(activity).toContainEqual(expect.objectContaining({ taskId: 101, body: 'Use the existing scheduler.' }))
  })

  it('refuses past the retry limit, and a ticket that is not blocked', async () => {
    const { storage, spec } = makeStorage([blocked({ retries: MAX_COORDINATOR_RETRIES })])
    await expect(retryTicket(storage, spec, { ticket: 8, instructions: 'again' }, 'Coord')).rejects.toThrow(/spec_escalate/)
    const other = makeStorage([blocked({ state: 'reviewing' })])
    await expect(retryTicket(other.storage, other.spec, { ticket: 8, instructions: 'again' }, 'Coord')).rejects.toThrow(/not blocked/)
  })

  it('blocks it again, for the coordinator, when the implementer cannot be woken', async () => {
    const { storage, spec, run } = makeStorage([blocked({ coordinator: 'asked' })])
    orchestrator.wakeTaskBinding.mockResolvedValueOnce(false)
    await expect(retryTicket(storage, spec, { ticket: 8, instructions: 'again' }, 'Coord')).rejects.toThrow(/could not be woken/)
    expect(run().build[0]).toMatchObject({ state: 'blocked', coordinator: 'asked' })
  })
})

describe('spec_escalate', () => {
  it('tells the user and settles the ticket it is about', () => {
    const { storage, spec, run } = makeStorage([blocked({ coordinator: 'asked' })])
    escalate(storage, spec, 'The design has no place for timers. Recommend a scheduler ticket.', 'Coord', 8)

    expect(run().build[0].coordinator).toBe('escalated')
    expect(notify).toHaveBeenCalledWith(storage, expect.objectContaining({ kind: 'spec_blocked', body: expect.stringContaining('no place for timers') }))
  })

  it('leaves a ticket it is not about to be reported on its own', () => {
    const { storage, spec, run } = makeStorage([blocked({ coordinator: 'asked' })])
    escalate(storage, spec, 'Something else entirely.', 'Coord')
    expect(run().build[0].coordinator).toBe('asked')
  })
})

describe('spec_integration_done', () => {
  async function conflicted() {
    await fs.mkdir(path.join(worktree, '.operon/changes/task-7'), { recursive: true })
    await fs.writeFile(path.join(worktree, '.operon/changes/task-7/integration.json'), JSON.stringify({ target: 'main', files: ['a.ts'], startedAt: 1 }))
    await fs.writeFile(path.join(worktree, 'a.ts'), 'change\n')
    git(worktree, 'add', '-A')
    git(worktree, 'commit', '-q', '-m', 'the change')
    await fs.writeFile(path.join(repo, 'a.ts'), 'main\n')
    git(repo, 'commit', '-qam', 'main moved')
    return makeStorage([], 'integrating')
  }

  it('wants the default branch merged in and committed first', async () => {
    const { storage, spec } = await conflicted()
    await expect(integrationDone(storage, spec, 'done')).rejects.toThrow(/not merged in/)

    try {
      git(worktree, 'merge', '-q', 'main')
    } catch {
      // conflicted, as intended
    }
    await expect(integrationDone(storage, spec, 'done')).rejects.toThrow(/merge is not finished/)
    expect(reviewRun.onAllTicketsMerged).not.toHaveBeenCalled()
  })

  it('records the summary and sends the resolution to review', async () => {
    const { storage, spec } = await conflicted()
    try {
      git(worktree, 'merge', '-q', 'main')
    } catch {
      // conflicted, as intended
    }
    await fs.writeFile(path.join(worktree, 'a.ts'), 'change and main\n')
    git(worktree, 'commit', '-qam', 'merge main')

    expect(await integrationDone(storage, spec, 'kept both')).toContain('Handed in')
    const integration = JSON.parse(await fs.readFile(path.join(worktree, '.operon/changes/task-7/integration.json'), 'utf8'))
    expect(integration.summary).toBe('kept both')
    expect(reviewRun.onAllTicketsMerged).toHaveBeenCalledWith(storage, 1)
  })

  it('is only for a spec that is integrating', async () => {
    const { storage, spec } = makeStorage([], 'awaiting_signoff')
    await expect(integrationDone(storage, spec, 'x')).rejects.toThrow(/not resolving/)
  })
})
