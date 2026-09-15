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

const handlers = vi.hoisted(() => ({ create: vi.fn(), send: vi.fn(), status: vi.fn(), stop: vi.fn() }))
vi.mock('../services/external-agent.js', () => ({
  createExternalAgent: handlers.create, sendExternalAgent: handlers.send,
  getExternalAgentStatus: handlers.status, stopExternalAgent: handlers.stop,
}))
vi.mock('../services/ai/providers.js', () => ({
  getProviders: () => [{ id: 'codex', available: true }],
  getProviderModels: async () => ({ models: [], currentModelId: undefined }),
}))
vi.mock('../services/ai/provider-models-cache.js', () => ({ warmAllProviders: async () => {} }))

const { externalAgentMcpRoutes } = await import('./external-agent-mcp.js')
const { takeCallerArg, UNKNOWN_CALLER_MESSAGE } = await import('./mcp-caller.js')

const run = { agent_type: 'codex', model: 'default', selection_confirmed: true, prompt: 'Review', description: 'Review' }

describe('per-call MCP caller identity', () => {
  const closers: Array<() => Promise<void>> = []

  async function connect(query: string): Promise<Client> {
    const app = new Hono()
    app.route('/api/external-agent-mcp', externalAgentMcpRoutes())
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const { port } = server.address() as AddressInfo
    const client = new Client({ name: 'caller-test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/external-agent-mcp${query}`)))
    closers.push(async () => {
      await client.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return client
  }

  beforeEach(() => {
    vi.clearAllMocks()
    bindings.clear()
    handlers.create.mockResolvedValue({ agent_id: 'ext-1', chat_id: 9 })
  })
  afterEach(async () => {
    await Promise.allSettled(closers.splice(0).map((close) => close()))
  })

  it('keeps routing by the chat id in the URL for clients that do not tag calls', async () => {
    const client = await connect('?caller=claude-code&chatId=42')
    await client.callTool({ name: 'external_agent_run', arguments: run })
    expect(handlers.create).toHaveBeenCalledWith(expect.objectContaining({ parentChatId: 42 }))
  })

  it('routes two OpenCode sessions sharing one URL to their own chats', async () => {
    bindings.set('ses_a', '101')
    bindings.set('ses_b', '202')
    const client = await connect('?caller=opencode&chatId=')
    await client.callTool({ name: 'external_agent_run', arguments: { ...run, [CALLER_ARG]: 'ses_a' } })
    await client.callTool({ name: 'external_agent_run', arguments: { ...run, [CALLER_ARG]: 'ses_b' } })
    handlers.send.mockReturnValue({ status: 'queued' })
    await client.callTool({ name: 'external_agent_send', arguments: { agent_id: 'ext-1', prompt: 'more', [CALLER_ARG]: 'ses_b' } })

    expect(handlers.create.mock.calls.map(([input]) => input.parentChatId)).toEqual([101, 202])
    // The routing argument never reaches the tool.
    expect(handlers.create.mock.calls[0][0]).toEqual({ parentChatId: 101, providerId: 'codex', model: 'default', prompt: 'Review', description: 'Review' })
    expect(handlers.send).toHaveBeenCalledWith(202, 'ext-1', 'more')
  })

  it('fails an unknown session instead of falling back to the URL', async () => {
    const client = await connect('?caller=opencode&chatId=42')
    const result = await client.callTool({ name: 'external_agent_run', arguments: { ...run, [CALLER_ARG]: 'ses_gone' } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain(UNKNOWN_CALLER_MESSAGE)
    expect(handlers.create).not.toHaveBeenCalled()
  })

  it('only takes the argument from tool calls', () => {
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { arguments: { [CALLER_ARG]: 'x' } } }
    expect(takeCallerArg(list)).toEqual({})
    const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 't', arguments: { a: 1, [CALLER_ARG]: 'ses_a' } } }
    expect(takeCallerArg(call)).toEqual({ caller: 'ses_a', requestId: 2 })
    expect(call.params.arguments).toEqual({ a: 1 })
  })
})
