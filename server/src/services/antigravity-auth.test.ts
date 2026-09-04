import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * These drive the real filesystem through a throwaway `$GEMINI_HOME`, because
 * that env var is exactly how the agent itself relocates its config — testing
 * it any other way would test a different code path than the one that runs.
 */
const shellEnv = vi.hoisted(() => ({ value: {} as Record<string, string> }))
const userEnv = vi.hoisted(() => ({ value: {} as Record<string, string> }))
vi.mock('./adapter/bundled-cli-paths.js', () => ({ getShellEnv: () => shellEnv.value }))
vi.mock('./env-config.js', () => ({ getEnvVars: () => userEnv.value }))

const { getAntigravityAuthStatus, setAntigravityAuthType } = await import('./antigravity-auth.js')

let home: string
const settingsFile = () => path.join(home, 'antigravity-acp', 'settings.json')

async function writeSettings(settings: unknown) {
  await mkdir(path.dirname(settingsFile()), { recursive: true })
  await writeFile(settingsFile(), JSON.stringify(settings))
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'gemini-home-test-'))
  shellEnv.value = {}
  userEnv.value = {}
  process.env.GEMINI_HOME = home
})

afterEach(async () => {
  delete process.env.GEMINI_HOME
  await rm(home, { recursive: true, force: true })
})

describe('getAntigravityAuthStatus', () => {
  it('reports not-configured when no method has been chosen', async () => {
    // The agent refuses session/new outright in this state.
    const status = await getAntigravityAuthStatus()
    expect(status.state).toBe('not-configured')
    expect(status.settingsPath).toBe(settingsFile())
  })

  it('warns that a browser will open when Google sign-in has no credentials yet', async () => {
    // This is the whole reason the check exists: without it, the login page
    // appears from inside the user's first chat message.
    await writeSettings({ auth: { type: 'oauth-personal' } })
    const status = await getAntigravityAuthStatus()
    expect(status.state).toBe('needs-login')
    expect(status.detail).toMatch(/browser/i)
  })

  it('is ready once the shared gemini credentials exist', async () => {
    await writeSettings({ auth: { type: 'oauth-personal' } })
    await writeFile(path.join(home, 'oauth_creds.json'), '{}')
    expect((await getAntigravityAuthStatus()).state).toBe('ready')
  })

  it('reads GEMINI_API_KEY from the environment the agent will be spawned with', async () => {
    // Not process.env: the key usually lives in the login shell or operon's
    // own env settings, neither of which is this process's environment.
    await writeSettings({ auth: { type: 'gemini-api-key' } })
    expect((await getAntigravityAuthStatus()).state).toBe('incomplete')

    shellEnv.value = { GEMINI_API_KEY: 'abc' }
    expect((await getAntigravityAuthStatus()).state).toBe('ready')

    shellEnv.value = {}
    userEnv.value = { GEMINI_API_KEY: 'abc' }
    expect((await getAntigravityAuthStatus()).state).toBe('ready')
  })

  it('requires both project and location for Gemini Enterprise', async () => {
    await writeSettings({ auth: { type: 'oauth-business' }, gcp: { project: 'p' } })
    expect((await getAntigravityAuthStatus()).state).toBe('incomplete')

    await writeSettings({ auth: { type: 'oauth-business' }, gcp: { project: 'p', location: 'us' } })
    expect((await getAntigravityAuthStatus()).state).toBe('ready')
  })

  it('accepts either an API key or a project+location for the agent platform', async () => {
    await writeSettings({ auth: { type: 'agent-platform' } })
    expect((await getAntigravityAuthStatus()).state).toBe('incomplete')

    shellEnv.value = { GOOGLE_API_KEY: 'k' }
    expect((await getAntigravityAuthStatus()).state).toBe('ready')

    shellEnv.value = { GOOGLE_CLOUD_PROJECT: 'p', GOOGLE_CLOUD_LOCATION: 'us' }
    expect((await getAntigravityAuthStatus()).state).toBe('ready')
  })

  it('does not pretend an unknown method is usable', async () => {
    await writeSettings({ auth: { type: 'telepathy' } })
    expect((await getAntigravityAuthStatus()).state).toBe('not-configured')
  })
})

describe('setAntigravityAuthType', () => {
  it('creates the settings file and reports the resulting state', async () => {
    const status = await setAntigravityAuthType('oauth-personal')
    expect(status.authType).toBe('oauth-personal')
    expect(status.state).toBe('needs-login')
    expect(JSON.parse(await readFile(settingsFile(), 'utf8'))).toEqual({ auth: { type: 'oauth-personal' } })
  })

  it('keeps settings it did not put there', async () => {
    // This file belongs to the gemini CLI family, not to operon — clobbering a
    // user's gcp block while switching sign-in method would be destructive.
    await writeSettings({ auth: { type: 'gemini-api-key' }, gcp: { project: 'p', location: 'us' }, other: 1 })
    await setAntigravityAuthType('oauth-personal')
    expect(JSON.parse(await readFile(settingsFile(), 'utf8'))).toEqual({
      auth: { type: 'oauth-personal' },
      gcp: { project: 'p', location: 'us' },
      other: 1,
    })
  })
})
