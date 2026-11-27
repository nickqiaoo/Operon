import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ shell: '' }))
vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  userInfo: () => ({ shell: fixture.shell }),
}))

it.skipIf(process.platform === 'win32')('shares refreshes and keeps the last environment when descendants hold the pipes open', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'operon-login-env-'))
  const shell = join(dir, 'shell')
  fixture.shell = shell
  try {
    await writeFile(shell, '#!/bin/sh\nexport OPERON_VALUE="one=two\nthree"\nexec /bin/sh -c "$2"\n', { mode: 0o700 })
    const { getShellEnv, refreshLoginShellEnv } = await import('./login-shell-env.js')
    await refreshLoginShellEnv()
    const snapshot = getShellEnv()
    expect(snapshot.OPERON_VALUE).toBe('one=two\nthree')
    await writeFile(shell, '#!/bin/sh\nsleep 6 &\nexit 0\n')
    const now = Date.now.bind(Date)
    vi.spyOn(Date, 'now').mockImplementation(() => now() + 31_000)
    const started = now()
    const refresh = refreshLoginShellEnv()
    expect(refreshLoginShellEnv()).toBe(refresh)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(getShellEnv()).toBe(snapshot)
    expect(now() - started).toBeLessThan(1500)
    await refresh
    expect(now() - started).toBeLessThan(5000)
    expect(getShellEnv()).toBe(snapshot)
  } finally {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  }
})
