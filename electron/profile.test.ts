import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const app = vi.hoisted(() => ({
  isPackaged: false,
  setName: vi.fn(),
  setPath: vi.fn(),
}))
vi.mock('electron', () => ({ app }))

describe('desktop profile bootstrap', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubEnv('OPERON_HOME', undefined)
    vi.stubEnv('OPERON_DEV', undefined)
    vi.stubEnv('VITE_DEV_SERVER_URL', undefined)
    app.isPackaged = false
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('sets an independent home and Chromium session before services load', async () => {
    vi.stubEnv('VITE_DEV_SERVER_URL', 'http://localhost:5173')
    await import('./profile.js')
    const home = path.join(os.homedir(), '.operon-dev')
    expect(process.env.OPERON_HOME).toBe(home)
    expect(process.env.OPERON_DEV).toBe('1')
    expect(app.setName).toHaveBeenCalledWith('Operon Dev')
    expect(app.setPath.mock.calls).toEqual([
      ['userData', path.join(home, 'electron')],
      ['sessionData', path.join(home, 'electron')],
    ])
  })

  it('respects an explicit app home without changing the CLI login home', async () => {
    const home = process.env.HOME
    vi.stubEnv('VITE_DEV_SERVER_URL', 'http://localhost:5173')
    vi.stubEnv('OPERON_HOME', '/tmp/operon-profile-test')
    await import('./profile.js')
    expect(app.setPath).toHaveBeenCalledWith('userData', '/tmp/operon-profile-test/electron')
    expect(process.env.HOME).toBe(home)
  })

  it('leaves the installed app paths unchanged, even with a stray Vite env var', async () => {
    app.isPackaged = true
    vi.stubEnv('VITE_DEV_SERVER_URL', 'http://localhost:5173')
    await import('./profile.js')
    expect(app.setPath).not.toHaveBeenCalled()
    expect(app.setName).not.toHaveBeenCalled()
    expect(process.env.OPERON_HOME).toBeUndefined()
  })
})
