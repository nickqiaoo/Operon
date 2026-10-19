import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { dataDir, materialize } = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/operon-mkt-cache-${process.pid}-${Date.now()}`
  process.env.OPERON_DATA_DIR = dir
  return { dataDir: dir, materialize: vi.fn() }
})

vi.mock('operon-agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('operon-agents')>()),
  materializeGithubRepo: materialize,
}))

const { browseMarketplaces } = await import('./plugins.js')

const cacheRoot = join(dataDir, 'operon-agents', 'marketplace-cache')
const key = 'acme-market-HEAD'

// Extract a fake repo whose single plugin is named after `version`, so a browse shows which copy it read.
async function extract(destDir: string, version: string): Promise<string> {
  const root = join(destDir, 'market-HEAD')
  await mkdir(join(root, '.agents', 'plugins'), { recursive: true })
  await mkdir(join(root, 'plugins', version), { recursive: true })
  await writeFile(
    join(root, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({ plugins: [{ name: version, source: { source: 'local', path: `./plugins/${version}` } }] }),
  )
  return root
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

async function ids(): Promise<string[]> {
  const res = await browseMarketplaces('acme/market')
  expect(res.errors).toEqual([])
  return res.entries.map((e) => e.id)
}

async function ageCache(ms: number): Promise<void> {
  const metaPath = join(cacheRoot, `${key}.json`)
  const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { root: string; at: number }
  await writeFile(metaPath, JSON.stringify({ ...meta, at: meta.at - ms }))
}

describe('marketplace repo cache', () => {
  beforeEach(() => { materialize.mockReset() })
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('downloads once for concurrent first browses, then serves a fresh cache without downloading', async () => {
    const gate = deferred()
    materialize.mockImplementation(async ({ destDir }: { destDir: string }) => {
      await gate.promise
      return extract(destDir, 'v1')
    })
    const both = Promise.all([ids(), ids()])
    await vi.waitFor(() => expect(materialize).toHaveBeenCalledTimes(1))
    gate.resolve()
    expect(await both).toEqual([['v1'], ['v1']])
    expect(materialize).toHaveBeenCalledTimes(1)

    expect(await ids()).toEqual(['v1'])
    expect(materialize).toHaveBeenCalledTimes(1)
  })

  it('serves a stale cache immediately and refreshes it in the background', async () => {
    await ageCache(25 * 60 * 60 * 1000)
    const gate = deferred()
    materialize.mockImplementation(async ({ destDir }: { destDir: string }) => {
      await gate.promise
      return extract(destDir, 'v2')
    })
    // The download is still blocked, yet the browse returns — from the old copy.
    expect(await ids()).toEqual(['v1'])
    expect(materialize).toHaveBeenCalledTimes(1)
    gate.resolve()
    await vi.waitFor(async () => expect(await ids()).toEqual(['v2']))
    expect(materialize).toHaveBeenCalledTimes(1)
  })

  it('keeps the current and previous versions, dropping older ones', async () => {
    await ageCache(25 * 60 * 60 * 1000)
    materialize.mockImplementation(async ({ destDir }: { destDir: string }) => extract(destDir, 'v3'))
    expect(await ids()).toEqual(['v2'])
    await vi.waitFor(async () => expect(await ids()).toEqual(['v3']))
    expect(await readdir(join(cacheRoot, key))).toHaveLength(2)
  })

  it('keeps serving the stale copy when the refresh fails', async () => {
    await ageCache(25 * 60 * 60 * 1000)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    materialize.mockRejectedValue(new Error('offline'))
    expect(await ids()).toEqual(['v3'])
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    expect(await ids()).toEqual(['v3'])
    warn.mockRestore()
  })
})
