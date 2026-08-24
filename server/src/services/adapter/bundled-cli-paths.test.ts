import { describe, it, expect, vi, beforeEach } from 'vitest'

// Which adapter has a configured path, and whether that path is executable, are
// the two inputs resolution actually depends on. Stub those rather than the
// resolver itself — spying on an export does not intercept a call made from
// inside the same module.
const configuredPaths = new Map<string, string>()
const executablePaths = new Set<string>()

vi.mock('../cli-path-config.js', async () => {
  const actual = await vi.importActual<typeof import('../cli-path-config.js')>('../cli-path-config.js')
  return { ...actual, getCliPathConfig: (id: string) => configuredPaths.get(id) }
})

let shellPath = ''
vi.mock('shell-env', () => ({ shellEnvSync: () => ({ PATH: shellPath }) }))

vi.mock('node:fs', () => ({
  accessSync: (p: string) => {
    if (!executablePaths.has(String(p))) throw new Error('ENOENT')
  },
  statSync: () => ({ isFile: () => true }),
  constants: { X_OK: 1 },
}))

// What `<cli> --version` does. `execFile` carries a promisify.custom that
// resolves to {stdout, stderr}, so the mock has to provide one too or
// promisify() falls back to its single-value convention and the probe sees
// undefined.
let versionProbe: () => Promise<{ stdout: string; stderr: string }> = async () => ({ stdout: '', stderr: '' })

vi.mock('node:child_process', () => {
  const execFile = () => {
    throw new Error('callback form unused')
  }
  execFile[Symbol.for('nodejs.util.promisify.custom') as unknown as keyof typeof execFile] = (() =>
    versionProbe()) as never
  return { execFile }
})

describe('isAdapterAvailable', () => {
  beforeEach(() => {
    vi.resetModules()
    configuredPaths.clear()
    executablePaths.clear()
    shellPath = ''
    process.env.PATH = ''
  })

  // The bug this file exists for: cursor shells out to `cursor-agent`, but fell
  // through to a `default: return true` and was advertised as available on
  // machines with no such binary. The first symptom was a failing message.
  it('reports a CLI adapter as unavailable when its binary is missing', async () => {
    const { isAdapterAvailable } = await import('./bundled-cli-paths.js')
    expect(isAdapterAvailable('cursor')).toBe(false)
    expect(isAdapterAvailable('opencode')).toBe(false)
  })

  it('reports a CLI adapter as available once its binary resolves', async () => {
    configuredPaths.set('cursor', '/usr/local/bin/cursor-agent')
    configuredPaths.set('opencode', '/usr/local/bin/opencode')
    executablePaths.add('/usr/local/bin/cursor-agent')
    executablePaths.add('/usr/local/bin/opencode')

    const { isAdapterAvailable } = await import('./bundled-cli-paths.js')
    expect(isAdapterAvailable('cursor')).toBe(true)
    expect(isAdapterAvailable('opencode')).toBe(true)
  })

  // A configured path that no longer exists must not count.
  it('ignores a configured path that is not executable', async () => {
    configuredPaths.set('cursor', '/gone/cursor-agent')
    const { isAdapterAvailable } = await import('./bundled-cli-paths.js')
    expect(isAdapterAvailable('cursor')).toBe(false)
  })

  // These ship inside node_modules, so there is no binary to find and they must
  // not be gated on one.
  it('always reports bundled-runtime adapters as available', async () => {
    const { isAdapterAvailable } = await import('./bundled-cli-paths.js')
    for (const id of ['gemini', 'custom']) {
      expect(isAdapterAvailable(id)).toBe(true)
    }
  })

  // copilot used to be on that list, back when the build shipped a 235M
  // @github/copilot platform binary. It resolves from PATH now, so claiming it
  // is always available would be the cursor bug again.
  it('gates copilot on a real binary now that it is no longer bundled', async () => {
    const { isAdapterAvailable } = await import('./bundled-cli-paths.js')
    expect(isAdapterAvailable('copilot')).toBe(false)
  })

  it('reports copilot as available once `copilot` is on PATH', async () => {
    shellPath = '/opt/homebrew/bin'
    executablePaths.add('/opt/homebrew/bin/copilot')

    const { isAdapterAvailable } = await import('./bundled-cli-paths.js')
    expect(isAdapterAvailable('copilot')).toBe(true)
  })

  // An adapter nobody registered must read as missing, not as ready. The old
  // permissive default is exactly how cursor slipped through.
  it('reports an unknown adapter as unavailable', async () => {
    const { isAdapterAvailable } = await import('./bundled-cli-paths.js')
    expect(isAdapterAvailable('some-adapter-added-later')).toBe(false)
  })

  // A headless node sets PATH in its systemd unit; the login shell knows nothing
  // about it. Resolution used to replace the process PATH with the shell's,
  // which made a CLI installed for the service invisible to the service.
  it('finds a binary that is only on the process PATH', async () => {
    process.env.PATH = '/opt/node/bin'
    shellPath = '/usr/bin:/bin'
    executablePaths.add('/opt/node/bin/opencode')

    const { isAdapterAvailable } = await import('./bundled-cli-paths.js')
    expect(isAdapterAvailable('opencode')).toBe(true)
  })

  // And the Electron case must keep working: there the login shell is the one
  // that knows where the user's tools are.
  it('finds a binary that is only on the login shell PATH', async () => {
    process.env.PATH = '/usr/bin'
    shellPath = '/Users/someone/.local/bin'
    executablePaths.add('/Users/someone/.local/bin/claude')

    const { isAdapterAvailable } = await import('./bundled-cli-paths.js')
    expect(isAdapterAvailable('claude-code')).toBe(true)
  })
})

describe('probeCliVersion', () => {
  beforeEach(() => {
    vi.resetModules()
    configuredPaths.clear()
    executablePaths.clear()
    shellPath = '/opt/homebrew/bin'
    process.env.PATH = ''
    executablePaths.add('/opt/homebrew/bin/copilot')
  })

  // Each CLI prints its own thing — "GitHub Copilot CLI 1.0.68." here,
  // "2.1.220 (Claude Code)" for Claude — so the parser takes the first
  // semver-shaped token rather than learning every format.
  it('parses the version out of whatever --version prints', async () => {
    versionProbe = async () => ({ stdout: 'GitHub Copilot CLI 1.0.99.\n', stderr: '' })
    const { probeCliVersion } = await import('./bundled-cli-paths.js')
    expect(await probeCliVersion('copilot')).toEqual({ version: '1.0.99' })
  })

  it('warns, but still reports the version, when the CLI is older than tested', async () => {
    versionProbe = async () => ({ stdout: 'GitHub Copilot CLI 1.0.68.\n', stderr: '' })
    const { probeCliVersion } = await import('./bundled-cli-paths.js')
    const info = await probeCliVersion('copilot')
    expect(info.version).toBe('1.0.68')
    expect(info.warning).toMatch(/1\.0\.73/)
    expect(info.error).toBeUndefined()
  })

  // The failure this whole probe exists to make visible: an npm-installed CLI
  // runs under the PATH `node`, and both Claude Code and Copilot statically
  // import `node:sea` (Node 20.12+). On an older Node the child dies during
  // module linking, and the SDK never notices — stdio start() resolves on spawn,
  // so the only symptom is an RPC that never answers.
  it('translates a too-old Node into an actionable message', async () => {
    versionProbe = async () => {
      throw Object.assign(new Error('Command failed'), {
        stderr: "Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sea",
      })
    }
    const { probeCliVersion } = await import('./bundled-cli-paths.js')
    const info = await probeCliVersion('copilot')
    expect(info.error).toMatch(/Node\.js \(20\.12\+\)/)
    expect(info.version).toBeUndefined()
  })

  it('reports a missing CLI without spawning anything', async () => {
    executablePaths.clear()
    versionProbe = async () => {
      throw new Error('should not spawn')
    }
    const { probeCliVersion } = await import('./bundled-cli-paths.js')
    expect((await probeCliVersion('copilot')).error).toMatch(/not found on your PATH/)
  })

  it('caches, so one probe per CLI does not become one per session', async () => {
    let calls = 0
    versionProbe = async () => {
      calls++
      return { stdout: 'GitHub Copilot CLI 1.0.99.\n', stderr: '' }
    }
    const { probeCliVersion } = await import('./bundled-cli-paths.js')
    await probeCliVersion('copilot')
    await probeCliVersion('copilot')
    expect(calls).toBe(1)
  })
})
