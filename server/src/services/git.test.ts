import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  MergeConflictError,
  WorkspaceUnavailableError,
  getDiffRange,
  commit,
  diffBeyondMerge,
  filesChangedBeyondMerge,
  getDefaultLocalBranch,
  isAncestor,
  isMerging,
  mergeBranch,
} from './git.js'

const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

describe('unavailable workspaces', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'operon-missing-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const initRepo = (repo: string) => {
    mkdirSync(repo)
    run(repo, 'init', '-q', '-b', 'main')
    run(repo, 'config', 'user.email', 'test@example.com')
    run(repo, 'config', 'user.name', 'test')
    run(repo, 'commit', '--allow-empty', '-qm', 'base')
  }

  it('reports missing directories without treating them as zero changes', async () => {
    await expect(getDiffRange(path.join(root, 'missing'), 'HEAD')).rejects.toBeInstanceOf(WorkspaceUnavailableError)
    writeFileSync(path.join(root, 'file'), '')
    await expect(getDiffRange(path.join(root, 'file'), 'HEAD')).rejects.toBeInstanceOf(WorkspaceUnavailableError)
  })

  it('detects removal after caching and recovers when the directory is recreated', async () => {
    const repo = path.join(root, 'repo')
    initRepo(repo)
    expect(await getDiffRange(repo, 'HEAD')).toEqual([])
    rmSync(repo, { recursive: true })
    await expect(getDiffRange(repo, 'HEAD')).rejects.toBeInstanceOf(WorkspaceUnavailableError)
    initRepo(repo)
    writeFileSync(path.join(repo, 'a.txt'), 'one\n')
    run(repo, 'add', '.')
    expect(await getDiffRange(repo, 'HEAD')).toMatchObject([{ path: 'a.txt', additions: 1 }])
    await expect(getDiffRange(repo, 'missing-ref')).rejects.not.toBeInstanceOf(WorkspaceUnavailableError)
  })
})

describe('mergeBranch', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'operon-merge-'))
    run(repo, 'init', '-q', '-b', 'main')
    run(repo, 'config', 'user.email', 'test@example.com')
    run(repo, 'config', 'user.name', 'test')
    writeFileSync(path.join(repo, 'a.txt'), 'one\n')
    run(repo, 'add', '.')
    run(repo, 'commit', '-qm', 'base')
    run(repo, 'checkout', '-qb', 'ticket')
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('returns the merge commit when the branches merge cleanly', async () => {
    writeFileSync(path.join(repo, 'b.txt'), 'two\n')
    run(repo, 'add', '.')
    run(repo, 'commit', '-qm', 'ticket work')
    run(repo, 'checkout', '-q', 'main')

    const sha = await mergeBranch(repo, 'ticket', 'Merge ticket')
    expect(sha).toBe(run(repo, 'rev-parse', 'HEAD'))
    expect(run(repo, 'log', '-1', '--format=%s')).toBe('Merge ticket')
  })

  // git reports a conflict on stdout, which simple-git does not treat as a failure.
  it('throws on a conflict and leaves the worktree clean', async () => {
    writeFileSync(path.join(repo, 'a.txt'), 'ticket\n')
    run(repo, 'commit', '-qam', 'ticket edit')
    run(repo, 'checkout', '-q', 'main')
    writeFileSync(path.join(repo, 'a.txt'), 'main\n')
    run(repo, 'commit', '-qam', 'main edit')
    const head = run(repo, 'rev-parse', 'HEAD')

    const err = await mergeBranch(repo, 'ticket').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MergeConflictError)
    expect((err as MergeConflictError).files).toEqual(['a.txt'])
    expect(run(repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(run(repo, 'status', '--porcelain')).toBe('')
  })
})

describe('commit with paths', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'operon-commit-'))
    run(repo, 'init', '-q', '-b', 'main')
    run(repo, 'config', 'user.email', 'test@example.com')
    run(repo, 'config', 'user.name', 'test')
    writeFileSync(path.join(repo, 'a.txt'), 'one\n')
    run(repo, 'add', '.')
    run(repo, 'commit', '-qm', 'base')
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  // A design agent's disposable worktree sits inside the change checkout while
  // the server commits a finished candidate next to it.
  it('commits only the given paths, never a nested worktree beside them', async () => {
    run(repo, 'worktree', 'add', '-q', '-b', 'scratch', path.join(repo, '.operon/worktrees/agent-1'))
    mkdirSync(path.join(repo, 'spec'), { recursive: true })
    writeFileSync(path.join(repo, 'spec/A.md'), 'candidate\n')
    writeFileSync(path.join(repo, 'a.txt'), 'unrelated edit\n')

    await commit(repo, 'candidate A', { paths: ['spec'] })

    expect(run(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('spec/A.md')
    expect(run(repo, 'status', '--porcelain', '--', 'a.txt')).toBe('M a.txt')
  })
})

describe('getDefaultLocalBranch', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'operon-default-'))
    run(repo, 'init', '-q', '-b', 'release/2.x')
    run(repo, 'config', 'user.email', 'test@example.com')
    run(repo, 'config', 'user.name', 'test')
    writeFileSync(path.join(repo, 'a.txt'), 'one\n')
    run(repo, 'add', '.')
    run(repo, 'commit', '-qm', 'base')
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('keeps every segment of a default branch with a slash in it', async () => {
    run(repo, 'remote', 'add', 'origin', 'https://example.com/repo.git')
    run(repo, 'update-ref', 'refs/remotes/origin/release/2.x', 'HEAD')
    run(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release/2.x')
    expect(await getDefaultLocalBranch(repo)).toBe('release/2.x')
  })

  it('is null without a remote', async () => {
    expect(await getDefaultLocalBranch(repo)).toBeNull()
  })
})

describe('filesChangedBeyondMerge', () => {
  let repo: string
  let reviewed: string

  const commitFile = (file: string, content: string, message: string) => {
    writeFileSync(path.join(repo, file), content)
    run(repo, 'add', '.')
    run(repo, 'commit', '-qm', message)
  }

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'operon-beyond-'))
    run(repo, 'init', '-q', '-b', 'main')
    run(repo, 'config', 'user.email', 'test@example.com')
    run(repo, 'config', 'user.name', 'test')
    commitFile('a.txt', 'one\n', 'base')
    run(repo, 'checkout', '-qb', 'change')
    commitFile('b.txt', 'change\n', 'the change')
    reviewed = run(repo, 'rev-parse', 'HEAD')
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('is empty when HEAD is what was reviewed', async () => {
    expect(await filesChangedBeyondMerge(repo, reviewed, 'main')).toEqual([])
  })

  it('leaves out what a clean merge of the default branch brought', async () => {
    run(repo, 'checkout', '-q', 'main')
    commitFile('c.txt', 'main\n', 'main moved')
    run(repo, 'checkout', '-q', 'change')
    run(repo, 'merge', '-q', '--no-ff', '-m', 'merge main', 'main')
    expect(await filesChangedBeyondMerge(repo, reviewed, 'main')).toEqual([])
  })

  it('names commits made after the review', async () => {
    commitFile('d.txt', 'later\n', 'unreviewed')
    expect(await filesChangedBeyondMerge(repo, reviewed, 'main')).toEqual(['d.txt'])
  })

  it('names edits not committed yet, new files too', async () => {
    writeFileSync(path.join(repo, 'b.txt'), 'edited\n')
    writeFileSync(path.join(repo, 'e.txt'), 'new\n')
    expect(await filesChangedBeyondMerge(repo, reviewed, 'main')).toEqual(['b.txt', 'e.txt'])
  })

  it('names the files of a merge conflict settled by hand', async () => {
    run(repo, 'checkout', '-q', 'main')
    commitFile('b.txt', 'main\n', 'main touched the same file')
    commitFile('c.txt', 'main\n', 'and another')
    run(repo, 'checkout', '-q', 'change')
    try {
      run(repo, 'merge', '-q', 'main')
    } catch {
      // conflicted, as intended
    }
    writeFileSync(path.join(repo, 'b.txt'), 'settled\n')
    run(repo, 'add', '.')
    run(repo, 'commit', '-qm', 'settle by hand')
    expect(await filesChangedBeyondMerge(repo, reviewed, 'main')).toEqual(['b.txt'])
    // As a diff: git's conflict markers replaced by the resolution, the clean part of the merge left out.
    const diff = await diffBeyondMerge(repo, reviewed, 'main')
    expect(diff).toContain('-<<<<<<<')
    expect(diff).toContain('+settled')
    expect(diff).not.toContain('c.txt')
  })

  it('says whether a branch is merged in, and whether a merge is under way', async () => {
    run(repo, 'checkout', '-q', 'main')
    commitFile('b.txt', 'main\n', 'main touched the same file')
    run(repo, 'checkout', '-q', 'change')
    expect(await isAncestor(repo, 'main')).toBe(false)
    expect(await isAncestor(repo, reviewed)).toBe(true)
    expect(await isAncestor(repo, 'no-such-branch')).toBe(false)
    try {
      run(repo, 'merge', '-q', 'main')
    } catch {
      // conflicted, as intended
    }
    expect(await isMerging(repo)).toBe(true)
    writeFileSync(path.join(repo, 'b.txt'), 'settled\n')
    run(repo, 'add', '.')
    run(repo, 'commit', '-qm', 'settle by hand')
    expect(await isMerging(repo)).toBe(false)
    expect(await isAncestor(repo, 'main')).toBe(true)
  })
})
