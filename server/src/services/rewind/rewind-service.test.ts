import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// `dataDir` is a module-level constant, so the sidecar repos must be redirected
// before the module is evaluated.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'rewind-data-'))
process.env.OPERON_DATA_DIR = DATA_DIR

const RewindService = await import('./rewind-service.js')

/**
 * These exercise real git: the whole point of the tree-to-tree plan is what git
 * does with two frozen trees versus the live worktree, which a stubbed exec
 * cannot demonstrate.
 */
describe('rewind-service', () => {
  let cwd: string

  const write = (file: string, content: string) => writeFile(path.join(cwd, file), content)
  const read = (file: string) => readFile(path.join(cwd, file), 'utf-8')
  const exists = (file: string) => read(file).then(() => true, () => false)

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'rewind-ws-'))
  })

  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true }).catch(() => {})
    rmSync(DATA_DIR, { recursive: true, force: true })
  })

  /**
   * The bug this whole change exists for: chat A rewinds, chat B had edited an
   * unrelated file in between, and B's edit gets reverted along with A's.
   */
  it('scopes the plan to one chat by diffing tree to tree', async () => {
    await write('a.ts', 'v1')
    await write('b.ts', 'v1')
    const start = await RewindService.capture(cwd)

    await write('a.ts', 'v2') // chat A, during its turn
    const end = await RewindService.capture(cwd)

    await write('b.ts', 'v2') // chat B, after A's turn closed

    // Tree to tree: fixed when `end` was written, so B's later edit cannot enter.
    expect(await RewindService.filesBetweenTrees(cwd, start!, end!)).toEqual(['a.ts'])

    // Diffing against the live worktree is what used to sweep b.ts in.
    const naive = await RewindService.diff(cwd, start!)
    expect(naive.map((entry) => entry.file).sort()).toEqual(['a.ts', 'b.ts'])
  })

  it('reverts only the planned files and leaves the rest alone', async () => {
    await write('a.ts', 'v1')
    await write('b.ts', 'v1')
    const start = await RewindService.capture(cwd)

    await write('a.ts', 'v2')
    const end = await RewindService.capture(cwd)

    await write('b.ts', 'v2')

    const result = await RewindService.revert(cwd, start!, {
      plan: new Map([['a.ts', start!]]),
      verifyAgainst: new Map([['a.ts', end!]]),
    })

    expect(result.success).toBe(true)
    expect(result.skipped).toEqual([])
    expect(await read('a.ts')).toBe('v1') // reverted
    expect(await read('b.ts')).toBe('v2') // the other chat's work survives
  })

  it('skips a planned file that changed after this chat last wrote it', async () => {
    await write('a.ts', 'v1')
    const start = await RewindService.capture(cwd)

    await write('a.ts', 'v2')
    const end = await RewindService.capture(cwd)

    await write('a.ts', 'v3') // someone else, after the turn closed

    const result = await RewindService.revert(cwd, start!, {
      plan: new Map([['a.ts', start!]]),
      verifyAgainst: new Map([['a.ts', end!]]),
    })

    expect(result.filesChanged).toEqual([])
    expect(result.skipped).toEqual([{ path: 'a.ts', reason: 'modified-by-others' }])
    expect(await read('a.ts')).toBe('v3') // untouched
  })

  it('reverts a skipped file when forced', async () => {
    await write('a.ts', 'v1')
    const start = await RewindService.capture(cwd)
    await write('a.ts', 'v2')
    const end = await RewindService.capture(cwd)
    await write('a.ts', 'v3')

    const result = await RewindService.revert(cwd, start!, {
      plan: new Map([['a.ts', start!]]),
      verifyAgainst: new Map([['a.ts', end!]]),
      force: true,
    })

    expect(result.skipped).toEqual([])
    expect(await read('a.ts')).toBe('v1')
  })

  it('deletes a planned file the target tree never had', async () => {
    await rm(path.join(cwd, 'created.ts'), { force: true })
    const start = await RewindService.capture(cwd)

    await write('created.ts', 'new')
    const end = await RewindService.capture(cwd)

    const result = await RewindService.revert(cwd, start!, {
      plan: new Map([['created.ts', start!]]),
      verifyAgainst: new Map([['created.ts', end!]]),
    })

    expect(result.success).toBe(true)
    expect(await exists('created.ts')).toBe(false)
  })

  it('restores only the named files on undo', async () => {
    await write('a.ts', 'v1')
    await write('b.ts', 'v1')
    const backup = await RewindService.capture(cwd)

    await write('a.ts', 'reverted')
    await write('b.ts', 'other chat')

    await RewindService.restoreFiles(cwd, backup!, ['a.ts'])

    expect(await read('a.ts')).toBe('v1') // put back
    expect(await read('b.ts')).toBe('other chat') // not in the list, so not rewritten
  })

  it('hashes worktree content the same way the tree stores it', async () => {
    await write('a.ts', 'same bytes')
    const tree = await RewindService.capture(cwd)

    expect(await RewindService.blobInWorktree(cwd, 'a.ts')).toBe(
      await RewindService.blobInTree(cwd, tree!, 'a.ts'),
    )

    await write('a.ts', 'different bytes')
    expect(await RewindService.blobInWorktree(cwd, 'a.ts')).not.toBe(
      await RewindService.blobInTree(cwd, tree!, 'a.ts'),
    )
  })

  it('reports a missing path as null on both sides', async () => {
    const tree = await RewindService.capture(cwd)
    expect(await RewindService.blobInTree(cwd, tree!, 'absent.ts')).toBeNull()
    expect(await RewindService.blobInWorktree(cwd, 'absent.ts')).toBeNull()
  })
})
