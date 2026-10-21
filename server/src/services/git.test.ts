import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MergeConflictError, commit, mergeBranch } from './git.js'

const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

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
