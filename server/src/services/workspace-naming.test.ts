import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const replies: string[] = []
const prompts: string[] = []
vi.mock('./ai/one-shot.js', () => ({
  runOneShotPrompt: vi.fn(async ({ prompt }: { prompt: string }) => {
    prompts.push(prompt)
    return replies.shift() ?? '{"title": null}'
  }),
}))
vi.mock('./commit-message-config.js', () => ({ getCommitMessageConfig: () => ({ providerId: 'claude', modelId: '' }) }))

const { SqliteStorage } = await import('../storage/sqlite.js')
const { provisionAutoWorkspace } = await import('./workspace-provision.js')
const naming = await import('./workspace-naming.js')
const { MAX_ATTEMPTS, nameWorkspaceBeforePush, nameWorkspaceFromMessage, parseWorkspaceName, resetWorkspaceNamingForTests, toSlug } = naming

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

describe('parseWorkspaceName', () => {
  it('reads the title and slug, tolerating prose and fences around the JSON', () => {
    expect(parseWorkspaceName('```json\n{"title": "Fix login timeout.", "slug": "Fix Login_Timeout"}\n```'))
      .toEqual({ title: 'Fix login timeout', slug: 'fix-login-timeout' })
  })

  it('is null when the model says the chat has not said what to do', () => {
    expect(parseWorkspaceName('{"title": null}')).toBeNull()
    expect(parseWorkspaceName('Sure! Here is a name')).toBeNull()
    expect(parseWorkspaceName('{"title": "  "}')).toBeNull()
  })

  it('keeps a Chinese title and falls back to the title for a missing slug', () => {
    expect(parseWorkspaceName('{"title": "修复登录超时", "slug": "fix-login-timeout"}')).toEqual({ title: '修复登录超时', slug: 'fix-login-timeout' })
    expect(parseWorkspaceName('{"title": "Add dark mode"}')).toEqual({ title: 'Add dark mode', slug: 'add-dark-mode' })
    expect(parseWorkspaceName('{"title": "修复登录超时"}')).toEqual({ title: '修复登录超时', slug: '' })
  })

  it('cuts a slug at a word boundary', () => {
    expect(toSlug('internationalization localization accessibility')).toBe('internationalization')
  })
})

let root: string
let repo: string
let storage: InstanceType<typeof SqliteStorage> | undefined
let projectId: number

beforeEach(async () => {
  resetWorkspaceNamingForTests()
  replies.length = 0
  prompts.length = 0
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-naming-')))
  process.env.OPERON_WORKTREES_DIR = path.join(root, 'worktrees')
  repo = path.join(root, 'repo')
  await fs.mkdir(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  await fs.writeFile(path.join(repo, 'app.ts'), 'main\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  try {
    storage = new SqliteStorage(':memory:')
  } catch {
    // better-sqlite3 is built for Electron's Node; see task-title-source.test.ts.
    storage = undefined
    return
  }
  projectId = storage.createProject({ name: 'repo', rootPath: repo }).id
})

afterEach(async () => {
  storage?.close()
  delete process.env.OPERON_WORKTREES_DIR
  await fs.rm(root, { recursive: true, force: true })
})


describe.skipIf(!process.versions.electron)('naming a chat worktree', () => {
  it('keeps the placeholder for a greeting, then names workspace and branch from a real ask', async () => {
    const ws = await provisionAutoWorkspace(storage!, { projectId, base: 'main' }, () => 'k3f9')

    expect(await nameWorkspaceFromMessage(storage!, ws.id, 'hi')).toBe(false)
    expect(storage!.getWorkspace(ws.id)).toMatchObject({ nameSource: 'placeholder', branchName: 'operon/k3f9' })

    replies.push('{"title": "Fix login timeout", "slug": "fix-login-timeout"}')
    expect(await nameWorkspaceFromMessage(storage!, ws.id, 'hi\n\nfix the login timeout')).toBe(true)
    expect(storage!.getWorkspace(ws.id)).toMatchObject({ nameSource: 'auto', name: 'Fix login timeout', branchName: 'operon/fix-login-timeout' })
    expect(git(ws.worktreePath, 'branch', '--show-current')).toBe('operon/fix-login-timeout')
    // The directory never moves.
    expect(storage!.getWorkspace(ws.id)?.worktreePath).toBe(ws.worktreePath)

    // Named: later messages ask nothing.
    prompts.length = 0
    expect(nameWorkspaceFromMessage(storage!, ws.id, 'now add tests')).toBeNull()
    expect(prompts).toEqual([])
  })

  it(`stops asking after ${MAX_ATTEMPTS} messages`, async () => {
    const ws = await provisionAutoWorkspace(storage!, { projectId, base: 'main' }, () => 'k3f9')
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      await nameWorkspaceFromMessage(storage!, ws.id, `hello ${i}`)
    }
    expect(prompts).toHaveLength(MAX_ATTEMPTS)
  })

  it('numbers a taken branch name and leaves workspaces it does not own alone', async () => {
    git(repo, 'branch', 'operon/add-dark-mode')
    const ws = await provisionAutoWorkspace(storage!, { projectId, base: 'main' }, () => 'k3f9')
    replies.push('{"title": "Add dark mode", "slug": "add-dark-mode"}')
    await nameWorkspaceFromMessage(storage!, ws.id, 'add dark mode')
    expect(storage!.getWorkspace(ws.id)?.branchName).toBe('operon/add-dark-mode-2')

    const typed = storage!.createWorkspace(projectId, { name: 'mine', branchName: 'main', worktreePath: repo })
    expect(nameWorkspaceFromMessage(storage!, typed.id, 'add dark mode')).toBeNull()
  })

  it('renames only the workspace once the branch has an upstream', async () => {
    const ws = await provisionAutoWorkspace(storage!, { projectId, base: 'main' }, () => 'k3f9')
    const remote = path.join(root, 'remote.git')
    git(root, 'init', '-q', '--bare', remote)
    git(ws.worktreePath, 'remote', 'add', 'origin', remote)
    git(ws.worktreePath, 'push', '-q', '-u', 'origin', 'operon/k3f9')
    replies.push('{"title": "Add dark mode", "slug": "add-dark-mode"}')
    await nameWorkspaceFromMessage(storage!, ws.id, 'add dark mode')
    expect(storage!.getWorkspace(ws.id)).toMatchObject({ name: 'Add dark mode', branchName: 'operon/k3f9' })
  })

  it('names a still-unnamed branch from its commits before a push', async () => {
    const remote = path.join(root, 'remote.git')
    git(root, 'init', '-q', '--bare', remote)
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', 'origin', 'main')
    const ws = await provisionAutoWorkspace(storage!, { projectId, base: 'main' }, () => 'k3f9')
    await fs.writeFile(path.join(ws.worktreePath, 'theme.ts'), 'dark\n')
    git(ws.worktreePath, 'add', '-A')
    git(ws.worktreePath, 'commit', '-qm', 'Add a dark theme')
    replies.push('{"title": "Add dark theme", "slug": "add-dark-theme"}')
    await nameWorkspaceBeforePush(storage!, `${ws.worktreePath}/`)
    expect(prompts[0]).toContain('Add a dark theme')
    expect(prompts[0]).toContain('Always give a name')
    expect(storage!.getWorkspace(ws.id)?.branchName).toBe('operon/add-dark-theme')
  })
})
