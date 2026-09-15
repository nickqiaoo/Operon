import { serve } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Hono } from 'hono'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CALLER_ARG = '__operon_opencode_session'
const bindings = vi.hoisted(() => new Map<string, string>())
vi.mock('@operon/agent-runtime', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveOpencodeCaller: (sessionId: string) => bindings.get(sessionId),
}))

// Stand-in kernel sessions: each remembers which conversation built it and what
// it was asked to run, which is all routing has to get right.
const built = vi.hoisted(() => [] as Array<{ sessionId: string; calls: Array<Record<string, unknown>>; hasHostElicitation: boolean }>)
vi.mock('@operon/computer-use', () => {
  class CuaDriverService {
    socketPath = '/tmp/cua.sock'
    async start() {}
    async stop() {}
  }
  class NodeReplHost {
    alive = true
    async dispose() {}
  }
  const listNodeReplTools = () => ({
    tools: [{ name: 'js', inputSchema: { type: 'object', properties: { source: { type: 'string' } } } }],
  })
  return {
    CuaDriverService,
    NodeReplHost,
    CUA_DRIVER_SOCKET_ENV: 'CUA',
    OPERON_COMPUTER_USE_CLIENT_PATH_ENV: 'CU_PATH',
    createTomlConfigStore: () => ({}),
    listNodeReplTools,
    buildNodeReplMcpServer: async (opts: {
      fallbackTurnMetadata: () => { session_id: string }
      integration?: { requestElicitation?: unknown }
    }) => {
      const session = {
        sessionId: opts.fallbackTurnMetadata().session_id,
        calls: [] as Array<Record<string, unknown>>,
        hasHostElicitation: typeof opts.integration?.requestElicitation === 'function',
      }
      built.push(session)
      return {
        server: {},
        listTools: listNodeReplTools,
        callTool: async (req: { params: { arguments?: Record<string, unknown> } }) => {
          session.calls.push({ ...(req.params.arguments ?? {}) })
          return { content: [{ type: 'text', text: `ran in ${session.sessionId}` }] }
        },
        dispose: async () => {},
      }
    },
  }
})
vi.mock('@operon/browser-use', () => ({ OPERON_BUILD_FLAVOR: 'dev', BUILD_FLAVOR_ENV: 'F', OPERON_BROWSER_CLIENT_PATH_ENV: 'B' }))
vi.mock('@operon/site-adapters', () => ({ OPERON_SITE_ADAPTERS_PATH_ENV: 'S' }))
vi.mock('../services/browser-use-config.js', () => ({ getBrowserUseConfig: () => ({ enabled: true }) }))
vi.mock('../services/computer-use-config.js', () => ({ getComputerUseConfig: () => ({ enabled: false }) }))
vi.mock('../services/chrome-use-config.js', () => ({ getChromeUseConfig: () => ({ enabled: false }) }))
vi.mock('../services/ai/host-elicitation.js', () => ({ requestOperonElicitation: async () => ({ action: 'accept' }) }))
vi.mock('../services/computer-use-lifecycle.js', () => ({ setComputerUseServiceStopHandler: () => {} }))

const { nodeReplMcpRoutes, disposeAllNodeReplSessions } = await import('./node-repl-mcp.js')
const { UNKNOWN_CALLER_MESSAGE } = await import('./mcp-caller.js')

describe('node_repl caller-routed endpoint', () => {
  const closers: Array<() => Promise<void>> = []

  async function connect(query = ''): Promise<Client> {
    const app = new Hono()
    app.route('/api/node-repl-mcp', nodeReplMcpRoutes())
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const { port } = server.address() as AddressInfo
    const client = new Client({ name: 'node-repl-test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/node-repl-mcp${query}`)))
    closers.push(async () => {
      await client.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return client
  }

  const text = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.stringify(result.content)

  beforeEach(() => {
    bindings.clear()
    built.length = 0
  })
  afterEach(async () => {
    await Promise.allSettled(closers.splice(0).map((close) => close()))
    await disposeAllNodeReplSessions()
  })

  it('runs each OpenCode session in its own conversation\'s kernel', async () => {
    bindings.set('ses_a', '101')
    bindings.set('ses_b', '202')
    const client = await connect()
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['js'])

    expect(text(await client.callTool({ name: 'js', arguments: { source: 'a = 1', [CALLER_ARG]: 'ses_a' } }))).toContain('ran in 101')
    expect(text(await client.callTool({ name: 'js', arguments: { source: 'b = 2', [CALLER_ARG]: 'ses_b' } }))).toContain('ran in 202')
    expect(text(await client.callTool({ name: 'js', arguments: { source: 'a', [CALLER_ARG]: 'ses_a' } }))).toContain('ran in 101')

    // One session per conversation, reused, never seeing the routing argument,
    // and asking for consent through the host rather than the MCP client.
    expect(built.map((session) => session.sessionId)).toEqual(['101', '202'])
    expect(built[0].calls).toEqual([{ source: 'a = 1' }, { source: 'a' }])
    expect(built[1].calls).toEqual([{ source: 'b = 2' }])
    expect(built.every((session) => session.hasHostElicitation)).toBe(true)
  })

  it('refuses a call that names no known conversation', async () => {
    const client = await connect()
    const untagged = await client.callTool({ name: 'js', arguments: { source: '1' } })
    expect(untagged.isError).toBe(true)
    expect(text(untagged)).toContain(UNKNOWN_CALLER_MESSAGE)
    const unknown = await client.callTool({ name: 'js', arguments: { source: '1', [CALLER_ARG]: 'ses_gone' } })
    expect(unknown.isError).toBe(true)
    expect(built).toEqual([])
  })
})
