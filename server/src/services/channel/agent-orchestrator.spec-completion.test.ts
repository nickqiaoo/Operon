import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SqliteStorage } from '../../storage/sqlite.js'
import { specDir, writeSpecFiles } from '../spec/files.js'
import { completeTaskAfterHumanReview, initOrchestrator } from './agent-orchestrator.js'
import { startIntegration } from '../spec/review-run.js'

vi.mock('../ai.js', () => ({ abortChat: vi.fn(), startChat: vi.fn(), startServerChat: vi.fn() }))
vi.mock('./binding-reset.js', () => ({ resetBinding: vi.fn() }))
vi.mock('../channel-bus.js', () => ({ emitChannelEvent: vi.fn(), emitProjectEvent: vi.fn() }))
vi.mock('../task-events.js', () => ({ broadcastTask: vi.fn() }))
vi.mock('../message-router.js', () => ({ deliverToBinding: vi.fn() }))
vi.mock('../binding-driver.js', () => ({
  deliverBinding: vi.fn(), handleBindingFinish: vi.fn(), registerBindingAdapter: vi.fn(),
  initBindingFinishDispatch: vi.fn(), MAX_IDLE_RETRIES: 3,
}))
vi.mock('../../gateway/surfaces/task-surface-bridge.js', () => ({
  SURFACE_PROMPT: '', observeTaskChatPart: vi.fn(), taskHasSurfaces: vi.fn(),
}))
vi.mock('../spec/spec-service.js', () => ({ specDesignChanged: vi.fn(async () => false) }))
vi.mock('../spec/review-run.js', () => ({
  startIntegration: vi.fn(async () => true), unreviewedFiles: vi.fn(async () => []),
}))
vi.mock('../spec/build-run.js', () => ({
  isReviewedTicket: vi.fn(), onTicketInReview: vi.fn(), onTicketLanded: vi.fn(),
  onTicketSentBack: vi.fn(), onTicketTurnEnded: vi.fn(), recordTicketChat: vi.fn(),
}))

let root: string
let repo: string
let worktree: string
let storage: SqliteStorage
let taskId: number
let number: number
const actor = { type: 'human' as const, id: null, name: 'You' }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

beforeEach(async () => {
  vi.clearAllMocks()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'spec-completion-'))
  repo = path.join(root, 'repo')
  worktree = path.join(root, 'worktree')
  await fs.mkdir(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  await fs.writeFile(path.join(repo, 'app.ts'), 'original\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  storage = new SqliteStorage(':memory:')
  const project = storage.createProject({ name: 'Spec completion', rootPath: repo })
  const task = storage.taskCreate({ projectId: project.id, title: 'Implement change' })
  taskId = task.id
  number = task.number
  const branchName = `operon/task-${number}`
  git(repo, 'worktree', 'add', '-qb', branchName, worktree)
  const workspace = storage.createWorkspace(project.id, { name: 'Spec', branchName, worktreePath: worktree })
  storage.taskUpdate(taskId, { workspaceId: workspace.id, branchName, status: 'in_review' })
  const seat = { providerId: 'codex' }
  storage.specRunCreate({
    taskId, stage: 'awaiting_signoff',
    config: { lead: seat, explorer: seat, candidates: [seat], judge: seat, builder: seat },
  })
  await writeSpecFiles(storage, { taskId, taskNumber: number, worktreePath: worktree }, {
    'brief.md': 'brief', 'design.md': 'design', 'review.md': 'review',
  }, 'review ready')
  await fs.writeFile(path.join(worktree, 'app.ts'), 'implemented\n')
  git(worktree, 'add', 'app.ts')
  git(worktree, 'commit', '-qm', 'implementation')
  initOrchestrator(storage)
})

afterEach(async () => {
  storage?.close()
  await fs.rm(root, { recursive: true, force: true })
})

it('lands the code, archives direct edits, and removes execution files before marking the spec done', async () => {
  await fs.writeFile(path.join(worktree, specDir(number), 'design.md'), 'latest design')
  expect(await completeTaskAfterHumanReview(taskId, actor)).toEqual({ ok: true })
  expect(await fs.readFile(path.join(repo, 'app.ts'), 'utf8')).toBe('implemented\n')
  await expect(fs.access(path.join(repo, specDir(number)))).rejects.toThrow()
  await expect(fs.access(worktree)).rejects.toThrow()
  expect(storage.specArtifactsRead(taskId)).toEqual({ 'brief.md': 'brief', 'design.md': 'latest design', 'review.md': 'review' })
  expect(storage.specRunGet(taskId)?.stage).toBe('done')
  expect(storage.taskGet(taskId)).toMatchObject({ status: 'done', workspaceId: null })
  expect(git(repo, 'status', '--porcelain')).toBe('')
  await expect(fs.access(path.join(repo, 'docs/adr'))).rejects.toThrow()
  await expect(fs.access(path.join(repo, 'GLOSSARY.md'))).rejects.toThrow()
})

it('keeps a rejected completion editable and can finish after the main checkout is cleaned', async () => {
  await fs.writeFile(path.join(repo, 'local.txt'), 'unrelated local work')
  const result = await completeTaskAfterHumanReview(taskId, actor)
  expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('uncommitted changes') })
  expect(storage.specRunGet(taskId)?.stage).toBe('awaiting_signoff')
  expect(await fs.readFile(path.join(worktree, specDir(number), 'design.md'), 'utf8')).toBe('design')
  expect(await fs.readFile(path.join(repo, 'local.txt'), 'utf8')).toBe('unrelated local work')
  await fs.rm(path.join(repo, 'local.txt'))
  expect(await completeTaskAfterHumanReview(taskId, actor)).toEqual({ ok: true })
  expect(storage.specRunGet(taskId)?.stage).toBe('done')
})

it('hands a default-branch conflict to integration before removing the execution files', async () => {
  await fs.writeFile(path.join(repo, 'app.ts'), 'main moved\n')
  git(repo, 'commit', '-qam', 'main moved')
  expect(await completeTaskAfterHumanReview(taskId, actor)).toMatchObject({ ok: false, pending: true })
  expect(startIntegration).toHaveBeenCalledWith(storage, expect.objectContaining({ id: taskId }), 'main', ['app.ts'])
  expect(await fs.readFile(path.join(worktree, specDir(number), 'design.md'), 'utf8')).toBe('design')
  expect(await fs.readFile(path.join(repo, 'app.ts'), 'utf8')).toBe('main moved\n')
  expect(storage.taskGet(taskId)?.status).toBe('in_review')
})
