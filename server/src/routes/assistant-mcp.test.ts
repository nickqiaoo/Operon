import { serve } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Hono } from 'hono'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { OPENCODE_CALLER_ARG } from '@operon/agent-runtime/opencode'
import { bindOpencodeCaller } from '../../../agent-runtime/src/providers/opencode/caller-identity.js'
import { assistantConversationId, assistantKeyQuery } from '../services/assistant/node-repl-bridge.js'
import { setAssistantToolHost, type AssistantToolHost } from '../services/assistant/tools.js'
import { assistantMcpRoutes } from './assistant-mcp.js'

const finish = vi.fn((_id: string) => true)
const startTask = vi.fn(async () => 'w42')

const host = {
  startTask,
  continueTask: async () => 'delivered' as const,
  stopTask: async () => true,
  listTasks: () => [],
  progress: () => undefined,
  finish: (id: string) => finish(id),
  heartbeatDone: () => true,
  onFileWritten: () => undefined,
  schedules: { list: () => [], create: vi.fn(), update: vi.fn(), remove: () => true },
} as unknown as AssistantToolHost

let base = ''
let close: () => Promise<void> = async () => {}

beforeAll(async () => {
  setAssistantToolHost(host)
  const app = new Hono()
  app.route('/api/assistant-mcp', assistantMcpRoutes())
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/assistant-mcp`
  close = () => new Promise<void>((resolve) => server.close(() => resolve()))
})
afterAll(async () => {
  setAssistantToolHost(undefined)
  await close()
})

async function connect(query: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}?${query}`)))
  return client
}

const text = (result: unknown) => ((result as { content: Array<{ text: string }> }).content[0]?.text ?? '')

describe('the assistant MCP route', () => {
  it("lists the main agent's tools on its URL, and runs them", async () => {
    const client = await connect(`${assistantKeyQuery()}&role=main`)
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain('start_task')
    expect(names).not.toContain('finish_task')
    const result = await client.callTool({ name: 'start_task', arguments: { title: 'Weather', prompt: 'Suzhou' } })
    expect(text(result)).toBe('Started task w42.')
    await client.close()
  })

  it("hands a worker's result in under the worker its URL names", async () => {
    const client = await connect(`${assistantKeyQuery()}&role=worker&id=w5`)
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['finish_task', 'heartbeat_done', 'report_progress'])
    await client.callTool({ name: 'finish_task', arguments: { title: 't', summary: 's', status: 'done' } })
    expect(finish).toHaveBeenLastCalledWith('w5')
    await client.close()
  })

  it('names the OpenCode session that made the call, not the URL another session registered', async () => {
    bindOpencodeCaller('oc-77', assistantConversationId({ role: 'worker', id: 'w77' }))
    const client = await connect(`${assistantKeyQuery()}&role=worker&id=w5`)
    await client.callTool({ name: 'finish_task', arguments: { title: 't', summary: 's', status: 'done', [OPENCODE_CALLER_ARG]: 'oc-77' } })
    expect(finish).toHaveBeenLastCalledWith('w77')
    await client.close()
  })

  it('refuses a call outside the caller role, even when the client was shown that tool', async () => {
    bindOpencodeCaller('oc-main-viewer', assistantConversationId({ role: 'worker', id: 'w8' }))
    const client = await connect(`${assistantKeyQuery()}&role=main`)
    const result = await client.callTool({ name: 'start_task', arguments: { title: 't', prompt: 'p', [OPENCODE_CALLER_ARG]: 'oc-main-viewer' } })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('start_task is not available here.')
    await client.close()
  })

  it('turns away a URL without the key', async () => {
    const response = await fetch(`${base}?role=main`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(response.status).toBe(403)
  })
})
