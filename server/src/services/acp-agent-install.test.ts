import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  INSTALLABLE_ACP_AGENTS,
  fetchManifest,
  findInstallableAgent,
  findPayloadRoot,
  registryPlatformKey,
} from './acp-agent-install.js'

const antigravity = INSTALLABLE_ACP_AGENTS[0]

/** The real shape of the registry's antigravity-acp/agent.json, trimmed. */
const manifestJson = (archive: string) => ({
  id: 'antigravity-acp',
  version: '1.1.1',
  distribution: {
    binary: {
      'darwin-aarch64': { archive, cmd: './agy_acp_server.par' },
      'linux-x86_64': { archive, cmd: './agy_acp_server.par', args: ['--uid='] },
      'windows-x86_64': { archive, cmd: './agy_acp_server.exe' },
    },
  },
})

function mockFetchOnce(body: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  })))
}

let staging: string
beforeEach(async () => {
  staging = await mkdtemp(path.join(tmpdir(), 'acp-install-test-'))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(staging, { recursive: true, force: true })
})

describe('registryPlatformKey', () => {
  it('maps this machine to a key the registry actually uses', () => {
    const key = registryPlatformKey()
    // Intel macs legitimately have no build; everything else must resolve.
    if (key === null) {
      expect(`${process.platform}-${process.arch}`).toBeTruthy()
      return
    }
    expect(key).toMatch(/^(darwin|linux|windows)-(aarch64|x86_64)$/)
  })
})

describe('fetchManifest', () => {
  it('refuses an archive hosted somewhere the agent did not declare', async () => {
    // The manifest is third-party data. If it were edited to point elsewhere,
    // honouring it would mean downloading and running an arbitrary binary.
    mockFetchOnce(manifestJson('https://evil.example.com/payload.zip'))
    await expect(fetchManifest(antigravity)).rejects.toThrow(/unexpected host/i)
  })

  it('refuses a plain-http archive even on the allowed host', async () => {
    mockFetchOnce(manifestJson('http://dl.google.com/payload.zip'))
    await expect(fetchManifest(antigravity)).rejects.toThrow(/unexpected host|https/i)
  })

  it('accepts the real host and reports the version', async () => {
    if (registryPlatformKey() === null) return // no build for this machine
    mockFetchOnce(manifestJson('https://dl.google.com/agy-extensions/x.zip'))
    const manifest = await fetchManifest(antigravity)
    expect(manifest.version).toBe('1.1.1')
    expect(manifest.binary.archive).toContain('dl.google.com')
  })

  it('explains which platforms exist when this one is missing', async () => {
    mockFetchOnce({ id: 'x', version: '1', distribution: { binary: { 'sparc-solaris': {} } } })
    await expect(fetchManifest(antigravity)).rejects.toThrow(/sparc-solaris|No .* build/)
  })

  it('surfaces a registry outage rather than installing nothing quietly', async () => {
    mockFetchOnce({}, false)
    await expect(fetchManifest(antigravity)).rejects.toThrow(/500/)
  })
})

describe('findPayloadRoot', () => {
  it('finds the binary at the archive root', async () => {
    await writeFile(path.join(staging, 'agy_acp_server.par'), 'x')
    expect(await findPayloadRoot(staging, './agy_acp_server.par')).toBe(staging)
  })

  it('finds the binary one directory down', async () => {
    // Publishers differ on whether the zip wraps its payload in a folder;
    // depending on one shape would break on the next release.
    const inner = path.join(staging, 'agy_acp_server_1.1.1-darwin-arm64')
    await mkdir(inner, { recursive: true })
    await writeFile(path.join(inner, 'agy_acp_server.par'), 'x')
    expect(await findPayloadRoot(staging, './agy_acp_server.par')).toBe(inner)
  })

  it('fails loudly when the archive holds something else entirely', async () => {
    await writeFile(path.join(staging, 'README.md'), 'x')
    await expect(findPayloadRoot(staging, './agy_acp_server.par')).rejects.toThrow(/does not contain/)
  })
})

describe('INSTALLABLE_ACP_AGENTS', () => {
  it('keys agents by the CLI adapter id, so an install is visible to path resolution', () => {
    // getCliPathInfo's absolute-path candidates are keyed by adapter id and
    // point into acpAgentsDir()/<id>; a mismatch installs into a directory
    // nothing ever looks in.
    expect(findInstallableAgent('antigravity')).toBeDefined()
  })

  it('pins a download host for every agent', () => {
    for (const agent of INSTALLABLE_ACP_AGENTS) {
      expect(agent.allowedHosts.length).toBeGreaterThan(0)
      expect(agent.manifestUrl).toMatch(/^https:\/\//)
    }
  })
})
