import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LocalEnvironment } from 'operon-agents'
import { SshEnvironment } from 'operon-agents/advanced'
import { it, expect, vi } from 'vitest'

vi.mock('./approved-extensions.js', () => ({ loadApprovedExtensions: vi.fn(), syncApprovedExtensions: vi.fn() }))
vi.mock('./plugin-skill-sync.js', async (load) => ({ ...await load<typeof import('./plugin-skill-sync.js')>(), syncPluginSkills: vi.fn() }))

it('opens a host workspace MCP for an SSH session on create and resume', async () => {
  const home = await mkdtemp(join(tmpdir(), 'operon-host-mcp-'))
  const host = join(home, 'host')
  const remote = join(home, 'remote')
  vi.stubEnv('OPERON_HOME', home)
  vi.stubEnv('OPERON_DATA_DIR', join(home, 'data'))
  try {
    await Promise.all([mkdir(host), mkdir(remote)])
    const command = { command: process.execPath, args: [fileURLToPath(new URL('../../../spike/assistant/echo-mcp.mjs', import.meta.url))] }
    await writeFile(join(host, '.mcp.json'), JSON.stringify({ mcpServers: { weather: command } }))
    await writeFile(join(remote, '.mcp.json'), JSON.stringify({ mcpServers: { remote_only: command } }))
    const sshEnvironment = { id: 'build', name: 'Build', host: 'build.test', port: 22, username: 'build', cwd: remote, hostFingerprint: 'test', keyPath: '/test-key' }
    vi.spyOn(SshEnvironment, 'create').mockImplementation(async () =>
      Object.assign(new LocalEnvironment(remote), { close: async () => {} }) as unknown as SshEnvironment)
    const { OperonRuntimeProvider, getOperonHarness } = await import('./index.js')
    const harness = await getOperonHarness()
    try {
      const provider = new OperonRuntimeProvider()
      const params = { cwd: remote, model: 'anthropic/claude-sonnet-4-6', operon: { sshEnvironment, hostWorkspace: host } }
      let resume: string | undefined
      for (let i = 0; i < 2; i++) {
        const runtime = await provider.createSession({ ...params, resume })
        try {
          resume = runtime.id!
          const session = harness.getSession(resume)!
          expect(session.environment.getcwd()).toBe(remote)
          const mcp = session.core.mcp
          expect(mcp?.list().map(entry => entry.name)).toEqual(['weather'])
          expect(await mcp?.listTools('weather')).toContainEqual(expect.objectContaining({ name: 'get_weather' }))
        } finally {
          await runtime.close()
        }
      }
    } finally {
      await harness.close()
    }
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
})
