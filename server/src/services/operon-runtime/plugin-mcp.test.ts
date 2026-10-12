import { describe, expect, it, vi } from 'vitest'
import type { PluginMcpServerExport } from './codex-plugin-apps.js'

let exportsFixture: PluginMcpServerExport[] = []
vi.mock('./plugins.js', () => ({
  pluginManager: { mcpServerExports: () => exportsFixture },
}))
vi.mock('./mcp-oauth.js', () => ({ hasMcpTokens: () => false, onMcpAuthChanged: () => () => {} }))

import { findGatewayServer, listPluginMcpMounts, pluginMcpMountName } from './plugin-mcp.js'

function server(name: string, config: PluginMcpServerExport['config'], requiresOAuth = false): PluginMcpServerExport {
  return { pluginId: 'acme', pluginName: 'Acme', server: name, runtimeName: `plugin-acme:${name}`, config, requiresOAuth }
}

describe('plugin MCP mounts', () => {
  it('names servers with underscores only', () => {
    expect(pluginMcpMountName('plugin-google-drive:drive')).toBe('plugin_google_drive_drive')
    expect(pluginMcpMountName('plugin-grafana-cloud:grafana-cloud')).toBe('plugin_grafana_cloud')
  })

  it('hands plain servers out directly and routes OAuth / filtered / cwd servers through the gateway', () => {
    exportsFixture = [
      server('local', { transport: 'stdio', command: '/p/bin/mcp', args: ['--x'], env: { A: '1' } }),
      server('remote', { transport: 'http', url: 'https://r.test/mcp', headers: { 'X-K': 'v' } }),
      server('oauth', { transport: 'http', url: 'https://o.test/mcp' }, true),
      server('filtered', { transport: 'stdio', command: 'x', allowedTools: ['read'] }),
      server('rooted', { transport: 'stdio', command: 'x', cwd: '/p' }),
    ]
    const mounts = Object.fromEntries(listPluginMcpMounts().map((m) => [m.server, m]))

    expect(mounts.local).toMatchObject({ kind: 'direct', entry: { command: '/p/bin/mcp', args: ['--x'], env: { A: '1' } } })
    expect(mounts.remote).toMatchObject({ kind: 'direct', entry: { type: 'http', url: 'https://r.test/mcp', headers: { 'X-K': 'v' } } })
    expect(mounts.oauth).toMatchObject({ kind: 'gateway', reason: 'oauth', name: 'plugin_acme_oauth' })
    expect(mounts.filtered).toMatchObject({ kind: 'gateway', reason: 'tool-filter' })
    expect(mounts.rooted).toMatchObject({ kind: 'gateway', reason: 'cwd' })
  })

  it('only resolves gateway names for servers the gateway actually routes', () => {
    exportsFixture = [
      server('remote', { transport: 'http', url: 'https://r.test/mcp' }),
      server('oauth', { transport: 'http', url: 'https://o.test/mcp' }, true),
    ]
    expect(findGatewayServer('plugin_acme_oauth')?.server).toBe('oauth')
    // A direct server is not proxyable, so the gateway can't be used to reach arbitrary URLs.
    expect(findGatewayServer('plugin_acme_remote')).toBeUndefined()
    expect(findGatewayServer('nope')).toBeUndefined()
  })
})
