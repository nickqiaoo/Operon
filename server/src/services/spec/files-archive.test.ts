import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restoreSpecFiles, specDir, withSpecFilesArchived, writeSpecFiles } from './files.js'

let root: string
let repo: string
let worktree: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function fixture() {
  const artifacts: Record<string, string> = {}
  const storage = {
    specArtifactsRead: () => ({ ...artifacts }),
    specArtifactsWrite: vi.fn((_taskId: number, files: Record<string, string | null>) => {
      for (const [key, content] of Object.entries(files)) {
        if (content === null) delete artifacts[key]
        else artifacts[key] = content
      }
    }),
  }
  return { storage, artifacts, loc: { taskId: 1, taskNumber: 7, worktreePath: worktree } }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'spec-archive-'))
  repo = path.join(root, 'repo')
  worktree = path.join(root, 'worktree')
  await fs.mkdir(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  await fs.writeFile(path.join(repo, 'app.ts'), 'original\n')
  await fs.mkdir(path.join(repo, specDir(8)), { recursive: true })
  await fs.writeFile(path.join(repo, specDir(8), 'design.md'), 'another spec')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  git(repo, 'worktree', 'add', '-qb', 'operon/task-7', worktree)
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('final Spec archive', () => {
  it('captures direct edits and nested files, then lands code without this spec directory', async () => {
    const { storage, artifacts, loc } = fixture()
    await writeSpecFiles(storage, loc, { 'design.md': 'design', 'candidates/A.md': 'A', 'feedback.md': 'old' }, 'design')
    await fs.writeFile(path.join(worktree, specDir(7), 'design.md'), 'edited design')
    await fs.writeFile(path.join(worktree, specDir(7), 'report.md'), 'agent report')
    await fs.rm(path.join(worktree, specDir(7), 'feedback.md'))
    await fs.writeFile(path.join(worktree, 'app.ts'), 'implemented\n')
    git(worktree, 'add', 'app.ts')
    git(worktree, 'commit', '-qm', 'implementation')

    await withSpecFilesArchived(storage, loc, async () => {
      expect(artifacts).toEqual({ 'design.md': 'edited design', 'candidates/A.md': 'A', 'report.md': 'agent report' })
      expect(git(worktree, 'ls-tree', '-r', '--name-only', 'HEAD', '--', specDir(7))).toBe('')
      git(repo, 'merge', '--no-ff', '-qm', 'land spec', 'operon/task-7')
      return { ok: true }
    })

    await expect(fs.access(path.join(repo, specDir(7)))).rejects.toThrow()
    await expect(fs.access(path.join(worktree, specDir(7)))).rejects.toThrow()
    expect(await fs.readFile(path.join(repo, 'app.ts'), 'utf8')).toBe('implemented\n')
    expect(await fs.readFile(path.join(repo, specDir(8), 'design.md'), 'utf8')).toBe('another spec')
    expect(artifacts['design.md']).toBe('edited design')
    expect(git(worktree, 'status', '--porcelain')).toBe('')
  })

  it.each(['rejected', 'thrown'] as const)('restores files after a %s landing and permits a retry', async (failure) => {
    const { storage, artifacts, loc } = fixture()
    await writeSpecFiles(storage, loc, { 'design.md': 'design' }, 'design')
    await fs.writeFile(path.join(worktree, specDir(7), 'design.md'), 'latest edit')
    const landing = () => withSpecFilesArchived(storage, loc, async () => {
      if (failure === 'thrown') throw new Error('merge failed')
      return { ok: false, reason: 'main is dirty' }
    })
    if (failure === 'thrown') await expect(landing()).rejects.toThrow('merge failed')
    else expect(await landing()).toMatchObject({ ok: false })

    expect(await fs.readFile(path.join(worktree, specDir(7), 'design.md'), 'utf8')).toBe('latest edit')
    expect(artifacts['design.md']).toBe('latest edit')
    expect(git(worktree, 'status', '--porcelain')).toBe('')
    expect(await withSpecFilesArchived(storage, loc, async () => ({ ok: true }))).toEqual({ ok: true })
  })

  it('leaves files and Git untouched when the final database snapshot fails', async () => {
    const { storage, loc } = fixture()
    await writeSpecFiles(storage, loc, { 'design.md': 'design' }, 'design')
    const head = git(worktree, 'rev-parse', 'HEAD')
    storage.specArtifactsWrite.mockImplementationOnce(() => { throw new Error('Database full') })
    const land = vi.fn(async () => ({ ok: true }))
    await expect(withSpecFilesArchived(storage, loc, land)).rejects.toThrow('Database full')
    expect(land).not.toHaveBeenCalled()
    expect(await fs.readFile(path.join(worktree, specDir(7), 'design.md'), 'utf8')).toBe('design')
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('restores an interrupted cleanup from its snapshot without overwriting later direct edits', async () => {
    const { storage, loc } = fixture()
    await writeSpecFiles(storage, loc, { 'design.md': 'design', 'candidates/A.md': 'A' }, 'design')
    await fs.rm(path.join(worktree, specDir(7)), { recursive: true })
    git(worktree, 'add', '-A')
    git(worktree, 'commit', '-qm', 'cleanup before interrupted landing')
    await restoreSpecFiles(storage, loc)
    expect(await fs.readFile(path.join(worktree, specDir(7), 'candidates/A.md'), 'utf8')).toBe('A')
    await fs.writeFile(path.join(worktree, specDir(7), 'design.md'), 'manual edit')
    await restoreSpecFiles(storage, loc)
    expect(await fs.readFile(path.join(worktree, specDir(7), 'design.md'), 'utf8')).toBe('manual edit')
  })
})
