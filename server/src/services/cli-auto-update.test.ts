import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StorageAdapter } from '../storage/interface.js'

// The login shell is irrelevant here (the CLI path is configured explicitly)
// and spawning one per test is slow.
vi.mock('shell-env', () => ({ shellEnvSync: () => ({}) }))

function memoryStorage(): StorageAdapter {
  const kv = new Map<string, unknown>()
  return {
    get: <T>(key: string) => kv.get(key) as T | undefined,
    set: (key: string, value: unknown) => void kv.set(key, value),
  } as unknown as StorageAdapter
}

/**
 * A stand-in `claude`: `--version` prints the version stored next to it, and
 * `update` replaces that version (or fails), the way the real updater moves
 * the binary the SDK will spawn next.
 */
function fakeCli(dir: string, { from, to, fail }: { from: string; to: string; fail?: string }): string {
  const versionFile = join(dir, 'version')
  writeFileSync(versionFile, from)
  const bin = join(dir, 'claude')
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `if [ "$1" = "--version" ]; then echo "$(cat '${versionFile}') (Claude Code)"; exit 0; fi`,
      fail
        ? `if [ "$1" = "update" ]; then echo "Checking for updates..."; echo "${fail}" >&2; exit 1; fi`
        : `if [ "$1" = "update" ]; then echo "${to}" > '${versionFile}'; echo "Updated"; exit 0; fi`,
      'exit 2',
    ].join('\n'),
  )
  chmodSync(bin, 0o755)
  return bin
}

describe('cli auto-update', () => {
  let dir: string

  beforeEach(() => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'cli-auto-update-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function setup(bin: string) {
    const storage = memoryStorage()
    const paths = await import('./cli-path-config.js')
    paths.initCliPathConfigService(storage)
    paths.setCliPathConfig('claude-code', bin)
    const service = await import('./cli-auto-update.js')
    service.initCliAutoUpdateService(storage)
    return service
  }

  it('records the version change when the update moves the CLI', async () => {
    const service = await setup(fakeCli(dir, { from: '2.1.1', to: '2.1.2' }))
    const status = await service.runCliUpdate('claude-code', 'manual')
    expect(status.running).toBe(false)
    expect(status.lastRun).toMatchObject({ outcome: 'updated', fromVersion: '2.1.1', toVersion: '2.1.2', trigger: 'manual' })
  })

  it('reports up to date when the version did not move', async () => {
    const service = await setup(fakeCli(dir, { from: '2.1.1', to: '2.1.1' }))
    const status = await service.runCliUpdate('claude-code', 'scheduled')
    expect(status.lastRun).toMatchObject({ outcome: 'up-to-date', toVersion: '2.1.1' })
  })

  it("surfaces the updater's last line when it fails", async () => {
    const service = await setup(fakeCli(dir, { from: '2.1.1', to: '2.1.2', fail: 'EACCES: permission denied' }))
    const status = await service.runCliUpdate('claude-code', 'manual')
    expect(status.lastRun?.outcome).toBe('failed')
    expect(status.lastRun?.error).toContain('EACCES: permission denied')
  })

  it('is off by default and only the toggled CLI turns on', async () => {
    const service = await setup(fakeCli(dir, { from: '2.1.1', to: '2.1.1' }))
    expect(service.getCliAutoUpdateState()['claude-code'].enabled).toBe(false)
    const enabled = service.setCliAutoUpdateEnabled('claude-code', true)
    expect(enabled.enabled).toBe(true)
    // Enabling with no previous check starts one right away.
    expect(enabled.running).toBe(true)
    expect(service.getCliAutoUpdateState().codex.enabled).toBe(false)
    await vi.waitFor(() => expect(service.getCliAutoUpdateStatus('claude-code').running).toBe(false))
  })
})
