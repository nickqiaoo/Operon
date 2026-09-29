import { serve } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { Hono } from 'hono'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PluginMcpServerExport } from '../services/operon-runtime/codex-plugin-apps.js'

let servers: PluginMcpServerExport[] = []
let tokensStored = false
// Hoisted: the route subscribes at module load, before ordinary top-level consts exist.
const { authListeners } = vi.hoisted(() => ({ authListeners: [] as Array<(runtimeName: string) => void> }))

vi.mock('../services/operon-runtime/plugins.js', () => ({ ensurePluginsLoaded: async () => {} }))
vi.mock('../services/operon-runtime/mcp-oauth.js', () => ({
  hasMcpTokens: () => tokensStored,
  mcpOAuthService: undefined,
  notifyMcpAuthChanged: (runtimeName: string) => authListeners.forEach((l) => l(runtimeName)),
  onMcpAuthChanged: (listener: (runtimeName: string) => void) => {
    authListeners.push(listener)
    return () => {}
  },
}))
const mountName = (runtimeName: string) => runtimeName.replace(/[^A-Za-z0-9_]/g, '_')
vi.mock('../services/operon-runtime/plugin-mcp.js', () => ({
  pluginMcpMountName: (runtimeName: string) => mountName(runtimeName),
  findGatewayServer: (name: string) => servers.find((s) => mountName(s.runtimeName) === name),
  listPluginMcpMounts: () => servers.map((s) => ({ kind: 'gateway', runtimeName: s.runtimeName })),
}))

import { mcpGatewayRoutes } from './mcp-gateway.js'

const require = createRequire(import.meta.url)

/** A real stdio MCP server exposing `echo` and `secret`, for the gateway to proxy. */
const UPSTREAM = `
import { Server } from ${JSON.stringify(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/index.js')).href)}
import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href)}
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/types.js')).href)}
const server = new Server({ name: 'upstream', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'secret', inputSchema: { type: 'object' } },
] }))
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: 'text', text: req.params.name + ':' + String(req.params.arguments?.text ?? '') }],
}))
await server.connect(new StdioServerTransport())
`

describe('mcp gateway route', () => {
  let baseUrl = ''
  let dir = ''
  let close: () => Promise<void> = async () => {}

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'operon-gateway-'))
    const script = path.join(dir, 'upstream.mjs')
    await writeFile(script, UPSTREAM, 'utf8')
    servers = [
      {
        pluginId: 'acme',
        pluginName: 'Acme',
        server: 'tools',
        runtimeName: 'plugin-acme:tools',
        config: { transport: 'stdio', command: process.execPath, args: [script], blockedTools: ['secret'] },
        requiresOAuth: false,
      },
      {
        pluginId: 'acme',
        pluginName: 'Acme',
        server: 'cloud',
        runtimeName: 'plugin-acme:cloud',
        // A stdio upstream standing in for an OAuth server: `url` only feeds the token lookup.
        config: { transport: 'stdio', command: process.execPath, args: [script], url: 'https://cloud.test/mcp' },
        requiresOAuth: true,
      },
    ]
    const app = new Hono()
    app.route('/api/mcp-gateway', mcpGatewayRoutes())
    const httpServer = serve({ fetch: app.fetch, port: 0 })
    await new Promise<void>((resolve) => (httpServer.listening ? resolve() : httpServer.once('listening', resolve)))
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/api/mcp-gateway`
    close = () => new Promise<void>((resolve) => httpServer.close(() => resolve()))
  })

  afterAll(async () => {
    servers = []
    // An empty routed set makes the next request prune (and close) the stdio upstream.
    await fetch(`${baseUrl}/nope`, { method: 'POST' }).catch(() => {})
    await close()
    await rm(dir, { recursive: true, force: true })
  })

  async function client(name: string): Promise<Client> {
    const c = new Client({ name: 'test', version: '1.0.0' })
    await c.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/${name}`)))
    return c
  }

  it('proxies tools/list and tools/call to the upstream, applying the tool filter', async () => {
    const c = await client('plugin_acme_tools')
    const { tools } = await c.listTools()
    expect(tools.map((t) => t.name)).toEqual(['echo'])
    const result = await c.callTool({ name: 'echo', arguments: { text: 'hi' } })
    expect(result.content).toEqual([{ type: 'text', text: 'echo:hi' }])
    const blocked = await c.callTool({ name: 'secret', arguments: {} })
    expect(blocked.isError).toBe(true)
    await c.close()
  })

  it('initializes a not-yet-signed-in server and offers connect_required instead of failing', async () => {
    tokensStored = false
    const c = await client('plugin_acme_cloud')
    const { tools } = await c.listTools()
    expect(tools.map((t) => t.name)).toEqual(['connect_required'])
    const result = await c.callTool({ name: 'connect_required', arguments: {} })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/Operon → Plugins/)
    await c.close()
  })

  it('pushes tools/list_changed on sign-in so the same session picks up the real tools', async () => {
    tokensStored = false
    const c = await client('plugin_acme_cloud')
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['connect_required'])
    const changed = new Promise<void>((resolve) => {
      c.setNotificationHandler(ToolListChangedNotificationSchema, async () => resolve())
    })

    tokensStored = true
    authListeners.forEach((listener) => listener('plugin-acme:cloud'))
    await changed

    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['echo', 'secret'])
    await c.close()
    tokensStored = false
  })

  it('404s names that are not gateway-routed plugin servers', async () => {
    const res = await fetch(`${baseUrl}/plugin_other_x`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
  })
})
