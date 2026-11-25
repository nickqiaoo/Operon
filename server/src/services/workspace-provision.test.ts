import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SqliteStorage } from '../storage/sqlite.js'
import { PLACEHOLDER_WORKSPACE_NAME, provisionAutoWorkspace } from './workspace-provision.js'

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

it('cuts an operon/<id> branch from the chosen base under a placeholder name', async () => {
  const first = await provisionAutoWorkspace(storage, { projectId, base: 'release' }, () => 'k3f9')
  expect(first).toMatchObject({ branchName: 'operon/k3f9', name: PLACEHOLDER_WORKSPACE_NAME, nameSource: 'placeholder' })
  expect(path.basename(first.worktreePath)).toBe('k3f9')
  expect(existsSync(first.worktreePath)).toBe(true)
  expect(git(first.worktreePath, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'release'))
  expect(storage.getWorkspace(first.id)?.nameSource).toBe('placeholder')
})

it('draws another id when one is taken', async () => {
  const ids = ['k3f9', 'k3f9', 'a1b2']
  await provisionAutoWorkspace(storage, { projectId, base: 'main' }, () => 'k3f9')
  const second = await provisionAutoWorkspace(storage, { projectId, base: 'main' }, () => ids.shift()!)
  expect(second.branchName).toBe('operon/a1b2')
})
