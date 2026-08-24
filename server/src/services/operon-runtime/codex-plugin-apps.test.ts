import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalMachine } from 'operon-agents'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OperonPluginManager, readCodexPluginApps } from './codex-plugin-apps.js'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Codex plugin App adapter', () => {
  it('honors official optional and required flags in .app.json', async () => {
    const root = await makePlugin('flags', {
      optional: { id: 'app_optional', optional: true },
      required: { id: 'app_required', required: true },
      explicitly_optional: { id: 'app_false', required: false },
      default_required: { id: 'app_default' },
    })

    await expect(readCodexPluginApps(root)).resolves.toEqual([
      { alias: 'optional', id: 'app_optional', required: false },
      { alias: 'required', id: 'app_required', required: true },
      { alias: 'explicitly_optional', id: 'app_false', required: false },
      { alias: 'default_required', id: 'app_default', required: true },
    ])
  })

  it('resolves app-only connectors into MCP configs and persists their enabled state in xui', async () => {
    const root = await makePlugin('notion-app', { notion: { id: 'app_notion', required: true } })
    const home = await tempDir('operon-plugin-home-')
    const resolver = vi.fn(async () => ({
      support: 'supported' as const,
      source: 'connector-registry' as const,
      requiresAuth: true,
      mcpServer: { transport: 'http' as const, url: 'https://mcp.notion.test/mcp' },
    }))
    const manager = new OperonPluginManager({ machine: new LocalMachine(home), homeDir: home, appResolver: resolver })

    await manager.install(root)
    expect(manager.mcpServerConfigs()['plugin-notion-app:notion']?.url).toBe('https://mcp.notion.test/mcp')
    expect(manager.mcpServerInfos('notion-app')[0]).toMatchObject({ requiresAuth: true, enabled: true })

    await manager.setMcpServerEnabled('notion-app', 'notion', false)
    expect(manager.mcpServerConfigs()['plugin-notion-app:notion']).toBeUndefined()

    const reloaded = new OperonPluginManager({ machine: new LocalMachine(home), homeDir: home, appResolver: resolver })
    await reloaded.load()
    expect(reloaded.mcpServerInfos('notion-app')[0]?.enabled).toBe(false)
    expect(reloaded.mcpServerConfigs()['plugin-notion-app:notion']).toBeUndefined()
  })

  it('allows unsupported optional apps but rejects unsupported required apps before installation', async () => {
    const optional = await makePlugin('optional-app', { calendar: { id: 'app_calendar', optional: true } })
    const required = await makePlugin('required-app', { calendar: { id: 'app_calendar', required: true } })
    const home = await tempDir('operon-plugin-policy-')
    const manager = new OperonPluginManager({
      machine: new LocalMachine(home),
      homeDir: home,
      appResolver: async () => ({ support: 'adapter-required', reason: 'native adapter required' }),
    })

    await expect(manager.install(optional)).resolves.toMatchObject({ id: 'optional-app' })
    expect(manager.blockedApp('optional-app')).toBeUndefined()
    await expect(manager.install(required)).rejects.toThrow('app "calendar" is not supported')
    expect(manager.get('required-app')).toBeUndefined()
  })

  it('uses a plugin-declared MCP server without consulting the connector registry', async () => {
    const root = await makePlugin('linear', { linear: { id: 'app_linear', required: true } }, {
      linear: { type: 'http', url: 'https://mcp.linear.test/mcp' },
    })
    const home = await tempDir('operon-plugin-mcp-')
    const resolver = vi.fn(async () => ({ support: 'unsupported' as const }))
    const manager = new OperonPluginManager({ machine: new LocalMachine(home), homeDir: home, appResolver: resolver })

    await manager.install(root)
    expect(resolver).not.toHaveBeenCalled()
    expect(manager.apps('linear')[0]).toMatchObject({ source: 'plugin-mcp', support: 'supported' })
    expect(manager.mcpServerConfigs()['plugin-linear:linear']?.url).toBe('https://mcp.linear.test/mcp')
  })

  it('isolates an installed plugin when a required App becomes unsupported on reload', async () => {
    const root = await makePlugin('reload-blocked', { notion: { id: 'app_notion', required: true } }, undefined, true)
    const home = await tempDir('operon-plugin-reload-')
    const supported = new OperonPluginManager({
      machine: new LocalMachine(home),
      homeDir: home,
      appResolver: async () => ({
        support: 'supported',
        mcpServer: { transport: 'http', url: 'https://mcp.notion.test/mcp' },
      }),
    })
    await supported.install(root)
    expect(supported.skillRoots()).toHaveLength(1)
    expect(supported.mcpServerConfigs()['plugin-reload-blocked:notion']).toBeDefined()

    const blocked = new OperonPluginManager({
      machine: new LocalMachine(home),
      homeDir: home,
      appResolver: async () => ({ support: 'unsupported', reason: 'connector removed' }),
    })
    await blocked.load()
    expect(blocked.blockedApp('reload-blocked')).toMatchObject({ alias: 'notion', required: true })
    expect(blocked.summaries()[0]).toMatchObject({ state: 'error', hasErrors: true, mcpServerCount: 0 })
    expect(blocked.skillRoots()).toEqual([])
    expect(blocked.mcpServerConfigs()['plugin-reload-blocked:notion']).toBeUndefined()
    expect(blocked.mcpServerConfig('reload-blocked', 'notion')).toBeUndefined()
  })
})

async function makePlugin(
  name: string,
  apps: Record<string, Record<string, unknown>>,
  mcpServers?: Record<string, Record<string, unknown>>,
  withSkill = false,
): Promise<string> {
  const root = await tempDir(`operon-plugin-${name}-`)
  await mkdir(join(root, '.codex-plugin'), { recursive: true })
  await writeFile(join(root, '.app.json'), JSON.stringify({ apps }))
  await writeFile(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name,
    apps: './.app.json',
    ...(withSkill ? { skills: './skills/' } : {}),
    ...(mcpServers !== undefined ? { mcpServers: './.mcp.json' } : {}),
  }))
  if (withSkill) {
    await mkdir(join(root, 'skills', 'demo'), { recursive: true })
    await writeFile(join(root, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: demo\n---\nDemo.\n')
  }
  if (mcpServers !== undefined) {
    await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers }))
  }
  return root
}

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}
