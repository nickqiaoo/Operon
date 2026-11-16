import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SqliteStorage } from '../storage/sqlite.js'
import { provisionAutoWorkspace, workspaceSlugFromHint } from './workspace-provision.js'

let root: string
let repo: string
let storage: SqliteStorage
let projectId: number

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'auto-workspace-')))
  process.env.OPERON_WORKTREES_DIR = path.join(root, 'worktrees')
  repo = path.join(root, 'repo')
  await fs.mkdir(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  await fs.writeFile(path.join(repo, 'app.ts'), 'main\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  git(repo, 'branch', 'release')
  storage = new SqliteStorage(':memory:')
  projectId = storage.createProject({ name: 'repo', rootPath: repo }).id
})

afterEach(async () => {
  storage?.close()
  delete process.env.OPERON_WORKTREES_DIR
  await fs.rm(root, { recursive: true, force: true })
})

it('names a workspace from the Latin words of the first message', () => {
  expect(workspaceSlugFromHint('Fix the login timeout, please!')).toBe('fix-the-login-timeout-please')
  expect(workspaceSlugFromHint('修一下 Settings 页面的 bug')).toBe('settings-bug')
  // Capped at five words and 32 characters.
  expect(workspaceSlugFromHint('one two three four five six seven')).toBe('one-two-three-four-five')
  expect(workspaceSlugFromHint('internationalization localization accessibility')).toBe('internationalization')
})

it('falls back to chat-<random> when the message has no Latin words', () => {
  expect(workspaceSlugFromHint('帮我看看这个问题', () => 'k3f9')).toBe('chat-k3f9')
  expect(workspaceSlugFromHint(undefined, () => 'a1b2')).toBe('chat-a1b2')
})

it('cuts an operon/<slug> branch from the chosen base, numbering a taken name', async () => {
  const first = await provisionAutoWorkspace(storage, { projectId, base: 'release', hint: 'Add dark mode' })
  expect(first.branchName).toBe('operon/add-dark-mode')
  expect(first.name).toBe('add-dark-mode')
  expect(existsSync(first.worktreePath)).toBe(true)
  expect(git(first.worktreePath, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'release'))

  const second = await provisionAutoWorkspace(storage, { projectId, base: 'main', hint: 'add dark mode' })
  expect(second.branchName).toBe('operon/add-dark-mode-2')
  expect(storage.listWorkspaces(projectId).map((w) => w.name)).toEqual(['add-dark-mode', 'add-dark-mode-2'])
})
