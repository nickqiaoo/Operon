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
