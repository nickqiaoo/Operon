import { serve } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { Hono } from 'hono'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { serveMcpStatefulOverHono } from './mcp-http.js'

describe('serveMcpStatefulOverHono', () => {
  const closeCallbacks: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.allSettled(closeCallbacks.splice(0).map((close) => close()))
  })

  it('lets a new MCP client replace the transport while preserving server state', async () => {
    let calls = 0
    const mcpServer = new Server(
      { name: 'stateful-reconnect-test', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{
        name: 'increment',
        description: 'Increment persistent state',
        inputSchema: { type: 'object', additionalProperties: false },
      }],
    }))
    mcpServer.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: 'text', text: String(++calls) }],
    }))

    const holder = {}
    const app = new Hono()
    app.all('/mcp', (c) => serveMcpStatefulOverHono(c, mcpServer, holder))
    const httpServer = serve({ fetch: app.fetch, port: 0 })
    closeCallbacks.push(async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error ? reject(error) : resolve())
      })
    })
    await new Promise<void>((resolve) => {
      if (httpServer.listening) resolve()
      else httpServer.once('listening', resolve)
    })
    const { port } = httpServer.address() as AddressInfo
    const url = new URL(`http://127.0.0.1:${port}/mcp`)

    const first = new Client({ name: 'first', version: '1.0.0' })
    await first.connect(new StreamableHTTPClientTransport(url))
    closeCallbacks.push(() => first.close())
    expect(await first.callTool({ name: 'increment', arguments: {} })).toMatchObject({
      content: [{ type: 'text', text: '1' }],
    })

    const second = new Client({ name: 'second', version: '1.0.0' })
    await second.connect(new StreamableHTTPClientTransport(url))
    closeCallbacks.push(() => second.close())
    expect(await second.callTool({ name: 'increment', arguments: {} })).toMatchObject({
      content: [{ type: 'text', text: '2' }],
    })
  })
})
