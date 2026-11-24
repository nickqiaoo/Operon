import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, expect, it as baseIt, vi } from 'vitest'
import { SqliteStorage } from '../../storage/sqlite.js'

// better-sqlite3 is built for Electron's Node; under a plain Node it does not load. Run with
// `ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run <this file>` to cover it
// (CI rebuilds it for Node first, so it runs there).
const sqliteLoads = (() => {
  try {
    new SqliteStorage(':memory:').close()
    return true
  } catch {
    return false
  }
})()
const it = baseIt.skipIf(!sqliteLoads)
import { abortChat } from '../ai.js'
import { stopDesignRun } from '../spec/design-run.js'
import { initOrchestrator } from './agent-orchestrator.js'

vi.mock('../ai.js', () => ({ abortChat: vi.fn(), startChat: vi.fn(), startServerChat: vi.fn() }))
vi.mock('./binding-reset.js', () => ({ resetBinding: vi.fn() }))
vi.mock('../channel-bus.js', () => ({ emitChannelEvent: vi.fn(), emitProjectEvent: vi.fn(), emitProjectTreeEvent: vi.fn(), publishChannelUnread: vi.fn(), registerChannelAttention: vi.fn() }))
vi.mock('../task-events.js', () => ({ broadcastTask: vi.fn() }))
vi.mock('../message-router.js', () => ({ deliverToBinding: vi.fn() }))
vi.mock('../rewind/index.js', () => ({ RewindService: { removeRepo: vi.fn(async () => {}) } }))
vi.mock('../binding-driver.js', () => ({
  deliverBinding: vi.fn(), handleBindingFinish: vi.fn(), registerBindingAdapter: vi.fn(),
  initBindingFinishDispatch: vi.fn(), MAX_IDLE_RETRIES: 3,
}))
vi.mock('../../gateway/surfaces/task-surface-bridge.js', () => ({
  SURFACE_PROMPT: '', observeTaskChatPart: vi.fn(), taskHasSurfaces: vi.fn(),
}))
vi.mock('../spec/spec-service.js', () => ({ specDesignChanged: vi.fn(async () => false) }))
vi.mock('../spec/design-run.js', () => ({ stopDesignRun: vi.fn(() => false) }))
vi.mock('../spec/review-run.js', () => ({
  startIntegration: vi.fn(async () => true), unreviewedFiles: vi.fn(async () => []),
}))
vi.mock('../spec/build-run.js', () => ({
  isReviewedTicket: vi.fn(), onTicketInReview: vi.fn(), onTicketLanded: vi.fn(),
  onTicketSentBack: vi.fn(), onTicketTurnEnded: vi.fn(), recordTicketChat: vi.fn(),
}))

let root: string
let repo: string
let storage: SqliteStorage
let projectId: number

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** A task with its own worktree; `spec` makes it an OperonSpec, `parentTaskId` one of its tickets. */
function createTask(options: { spec?: boolean; parentTaskId?: number; status?: 'todo' | 'in_progress' | 'in_review' } = {}) {
  const task = storage.taskCreate({ projectId, title: 'A task', parentTaskId: options.parentTaskId })
  const branchName = `operon/task-${task.number}`
  const worktreePath = path.join(root, 'worktrees', `${projectId}-repo`, `task-${task.number}`)
  git(repo, 'worktree', 'add', '-qb', branchName, worktreePath)
  const workspace = storage.createWorkspace(projectId, { name: `task #${task.number}`, branchName, worktreePath })
  storage.taskUpdate(task.id, { workspaceId: workspace.id, branchName, status: options.status ?? 'in_review' })
  if (options.spec) {
    const seat = { providerId: 'codex' }
    storage.specRunCreate({
      taskId: task.id, stage: 'awaiting_signoff',
      config: { lead: seat, explorer: seat, candidates: [seat], judge: seat, builder: seat },
    })
  }
  return { taskId: task.id, branchName, worktreePath, workspaceId: workspace.id }
}

/** The reclaim runs off the storage write; wait for the row to go. */
async function settled(workspaceId: number): Promise<void> {
  await vi.waitFor(() => expect(storage.getWorkspace(workspaceId)).toBeNull(), { timeout: 5000 })
}

beforeEach(async () => {
  vi.clearAllMocks()
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-cleanup-')))
  process.env.OPERON_WORKTREES_DIR = path.join(root, 'worktrees')
  repo = path.join(root, 'repo')
  await fs.mkdir(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  await fs.writeFile(path.join(repo, 'app.ts'), 'original\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  storage = new SqliteStorage(':memory:')
  projectId = storage.createProject({ name: 'repo', rootPath: repo }).id
  initOrchestrator(storage)
})

afterEach(async () => {
  storage?.close()
  delete process.env.OPERON_WORKTREES_DIR
  await fs.rm(root, { recursive: true, force: true })
})

it('archiving deletes the worktree, uncommitted work and all, but keeps the branch', async () => {
  const task = createTask()
  await fs.writeFile(path.join(task.worktreePath, 'draft.ts'), 'unsaved\n')

  storage.taskSetArchived(task.taskId, true)
  await settled(task.workspaceId)

  expect(existsSync(task.worktreePath)).toBe(false)
  expect(storage.taskGet(task.taskId)?.workspaceId).toBeNull()
  expect(git(repo, 'worktree', 'list')).not.toContain(task.worktreePath)
  expect(git(repo, 'branch', '--list', task.branchName)).toContain(task.branchName)
})

it('cancelling through any path stops what runs there and deletes the worktree', async () => {
  const task = createTask({ status: 'in_progress' })
  const agent = storage.createAgent({ name: 'builder', provider: 'codex', model: 'gpt' })
  const binding = storage.upsertBinding({
    agentId: agent.id, scopeKind: 'task', scopeKey: String(task.taskId), projectId, workspaceId: task.workspaceId,
    activeChatId: 42,
  })
  storage.taskUpdate(task.taskId, { bindingId: binding.id })

  // A plain storage write, as the agent's MCP tool and the Linear sync do.
  storage.taskUpdate(task.taskId, { status: 'cancelled' }, { type: 'agent', id: agent.id, name: 'builder' })
  await settled(task.workspaceId)

  expect(stopDesignRun).toHaveBeenCalledWith(task.taskId)
  expect(abortChat).toHaveBeenCalledWith(42)
  expect(existsSync(task.worktreePath)).toBe(false)
  expect(storage.getBinding(binding.id)?.workspaceId).toBeNull()
})

it('archiving a spec reclaims its tickets too', async () => {
  const spec = createTask({ spec: true })
  const ticket = createTask({ parentTaskId: spec.taskId })

  storage.taskSetArchived(spec.taskId, true)
  await settled(spec.workspaceId)
  await settled(ticket.workspaceId)

  expect(existsSync(spec.worktreePath)).toBe(false)
  expect(existsSync(ticket.worktreePath)).toBe(false)
})

it('a worktree already gone from disk still drops its row', async () => {
  const task = createTask()
  await fs.rm(task.worktreePath, { recursive: true, force: true })

  storage.taskSetArchived(task.taskId, true)
  await settled(task.workspaceId)

  expect(git(repo, 'worktree', 'list')).not.toContain(task.worktreePath)
})

it('brings a spec back with its change worktree checked out from the kept branch', async () => {
  const spec = createTask({ spec: true })
  await fs.writeFile(path.join(spec.worktreePath, 'app.ts'), 'designed\n')
  git(spec.worktreePath, 'commit', '-qam', 'design')

  storage.taskSetArchived(spec.taskId, true)
  await settled(spec.workspaceId)
  storage.taskSetArchived(spec.taskId, false)

  await vi.waitFor(() => expect(storage.taskGet(spec.taskId)?.workspaceId).not.toBeNull(), { timeout: 5000 })
  const workspaceId = storage.taskGet(spec.taskId)?.workspaceId
  expect(workspaceId != null ? storage.getWorkspace(workspaceId)?.worktreePath : null).toBe(spec.worktreePath)
  expect(await fs.readFile(path.join(spec.worktreePath, 'app.ts'), 'utf8')).toBe('designed\n')
})

it('un-cancelling a spec restores its worktree as well', async () => {
  const spec = createTask({ spec: true, status: 'todo' })
  storage.taskUpdate(spec.taskId, { status: 'cancelled' })
  await settled(spec.workspaceId)

  storage.taskUpdate(spec.taskId, { status: 'todo' })

  // The row is the restore's last step; the directory appears while git is still checking out.
  await vi.waitFor(() => expect(storage.taskGet(spec.taskId)?.workspaceId).not.toBeNull(), { timeout: 5000 })
  expect(existsSync(spec.worktreePath)).toBe(true)
})

it('leaves the worktree of a task that is only moving between open states', async () => {
  const task = createTask({ status: 'in_progress' })

  storage.taskUpdate(task.taskId, { status: 'in_review' })
  storage.taskUpdate(task.taskId, { title: 'Renamed' })
  await new Promise((resolve) => setTimeout(resolve, 200))

  expect(storage.getWorkspace(task.workspaceId)).not.toBeNull()
  expect(existsSync(task.worktreePath)).toBe(true)
})
