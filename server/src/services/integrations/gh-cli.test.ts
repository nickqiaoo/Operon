import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { getGhStatus, ghPrCreate, ghPrForBranch } from './gh-cli.js'

it('uses PATH added after the gh module was loaded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'operon-gh-test-'))
  const originalPath = process.env.PATH

  try {
    const gh = join(dir, 'gh')
    await writeFile(gh, `#!/bin/sh
case "$1 $2" in
  "auth token") printf 'test-token' ;;
  "pr create") printf 'https://github.com/example/repo/pull/42\\n' ;;
  "pr list") printf '[{"number":42,"url":"https://github.com/example/repo/pull/42","title":"Example","isDraft":false}]' ;;
  *) exit 1 ;;
esac
`)
    await chmod(gh, 0o755)
    process.env.PATH = dir

    expect(await getGhStatus()).toEqual({ isInstalled: true, isAuthenticated: true })
    expect((await ghPrCreate(dir, {
      headBranch: 'feature',
      baseBranch: 'main',
      title: 'Example',
      body: '',
    })).number).toBe(42)
    expect((await ghPrForBranch(dir, 'feature'))?.number).toBe(42)
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    await rm(dir, { recursive: true, force: true })
  }
})

it('summarizes a PR list: checks passed / failed / pending, review decision, author', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'operon-gh-list-'))
  const originalPath = process.env.PATH
  const pr = {
    number: 7, title: 'Add subtract', url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false,
    headRefName: 'subtract', baseRefName: 'main', author: { login: 'nick' }, updatedAt: '2026-10-14T00:00:00Z',
    reviewDecision: 'CHANGES_REQUESTED',
    statusCheckRollup: [
      { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'build', status: 'IN_PROGRESS', conclusion: null },
      { context: 'ci/legacy', state: 'SUCCESS' },
    ],
  }
  try {
    const gh = join(dir, 'gh')
    await writeFile(gh, `#!/bin/sh\n[ "$1 $2" = "pr list" ] && printf '%s' '${JSON.stringify([pr])}' || exit 1\n`)
    await chmod(gh, 0o755)
    process.env.PATH = dir
    const { ghPrList } = await import('./gh-cli.js')
    expect(await ghPrList(dir)).toEqual([
      {
        number: 7, title: 'Add subtract', url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false,
        headRefName: 'subtract', baseRefName: 'main', author: 'nick', updatedAt: '2026-10-14T00:00:00Z',
        reviewDecision: 'CHANGES_REQUESTED', checks: { passed: 2, failed: ['test'], pending: 1 },
      },
    ])
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    await rm(dir, { recursive: true, force: true })
  }
})
