import { serve } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Hono } from 'hono'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// What is installed on the machine, as the route sees it. The route reads this
// live per request (it is deliberately NOT passed in on the URL), so the way to
// vary it per case is here rather than in the connect string.
const providerState = vi.hoisted(() => ({ installed: ['codex'] }))

vi.mock('../services/ai/providers.js', () => ({
  getProviders: () => providerState.installed.map((id) => ({ id, available: true })),
  getProviderModels: async () => ({ models: [], currentModelId: undefined, modelsPending: false }),
}))
vi.mock('../services/ai/provider-models-cache.js', () => ({ warmAllProviders: async () => {} }))

const {
  LIST_MODELS_TOOL_NAME,
  WORKFLOW_MCP_TOOL_NAME,
  workflowMcpRoutes,
  workflowToolDescription,
} = await import('./workflow-mcp.js')

describe('Workflow MCP tool contract', () => {
  const closeCallbacks: Array<() => Promise<void>> = []

  beforeEach(() => {
    providerState.installed = ['codex']
  })

  afterEach(async () => {
    await Promise.allSettled(closeCallbacks.splice(0).map((close) => close()))
  })

  it('uses the renamed tool and keeps the complete core contract within Grok discovery limits', () => {
    const description = workflowToolDescription([
      'codex',
      'claude-code',
      'gemini',
      'kimi',
      'opencode',
      'cursor',
      'grok',
      'copilot',
    ])

    expect(WORKFLOW_MCP_TOOL_NAME).toBe('OperonWorkflow')
    expect(description.length).toBeLessThanOrEqual(2_000)
    expect(description).toContain('/operon-workflow')
    expect(description).toContain('agent(prompt: string, options?)')
    expect(description).toContain('never call agent({ prompt: ... })')
    expect(description).toContain('parallel([() => agent(...), ...])')
    // agentType is mandatory — the contract must say so, list the ids available
    // here, and tell the caller to ask rather than pick one.
    expect(description).toContain('Every agent() MUST name an agentType')
    expect(description).toContain('codex, claude-code')
    expect(description).toContain('There is no default')
    expect(description).toContain('YOU MUST ASK THE USER')
    // The model is the user's choice too — and the catalog is too long for a
    // description with a 2000-char ceiling, so the contract has to name the
    // tool that carries it.
    expect(description).toContain('ListAgentModels')
    expect(description).toContain('model (REQUIRED)')
    expect(description).toContain('agents_chosen_by_user: true')
    // The in-app agent is named `operon` (never the internal id), offered last,
    // and gated on the user asking for it.
    expect(description).toContain('operon is the app')
    expect(description).toContain('ONLY when the user explicitly asks for it')
    expect(description).not.toContain('custom')
    expect(description).toContain('ALWAYS in the background')
    expect(description).not.toContain('run_in_background')
    // The host agent may ship its own workflow tool; the model must not pick
    // between them on the user's behalf.
    expect(description).toContain('TWO workflow tools')
    expect(description).toContain('OperonWorkflow')
    expect(description).toContain('Ask the user which one to use')
    expect(description).not.toContain('scriptPath')
    expect(description).not.toContain('BackgroundOutput')
    expect(description).not.toContain('tokenBudget')
  })

  it('publishes the short contract and guarded script schema over MCP', async () => {
    providerState.installed = ['codex', 'grok']
    const app = new Hono()
    app.route('/api/workflow-mcp', workflowMcpRoutes())
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
    const client = new Client({ name: 'workflow-contract-test', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/api/workflow-mcp`),
      ),
    )
    closeCallbacks.push(() => client.close())

    const result = await client.listTools()

    expect(result.tools.map((t) => t.name)).toEqual(['OperonWorkflow', LIST_MODELS_TOOL_NAME])
    expect(result.tools[0]?.name).toBe('OperonWorkflow')
    expect(result.tools[0]?.description).toBe(workflowToolDescription(['codex', 'grok', 'operon']))
    expect(result.tools[0]?.inputSchema.properties?.script).toMatchObject({
      type: 'string',
      description: expect.stringContaining('parallel([() => agent(...), ...])'),
    })
  })

  it('rejects a script whose agents name no agentType, before any run starts', async () => {
    const app = new Hono()
    app.route('/api/workflow-mcp', workflowMcpRoutes())
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
    const client = new Client({ name: 'workflow-agenttype-test', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/api/workflow-mcp`),
      ),
    )
    closeCallbacks.push(() => client.close())

    const script = [
      "export const meta = { name: 'no-agent-type', description: 'x', phases: [{ title: 'P' }] }",
      "phase('P')",
      "return await agent('do a thing', { label: 'thing' })",
    ].join('\n')

    const result = (await client.callTool({
      name: WORKFLOW_MCP_TOOL_NAME,
      arguments: { script, agents_chosen_by_user: true },
    })) as { isError?: boolean; content?: Array<{ text?: string }> }

    expect(result.isError).toBe(true)
    const text = result.content?.[0]?.text ?? ''
    // Names the choices (they are installation-specific) and points at the user.
    expect(text).toContain('codex, operon')
    expect(text).toContain('There is no default')
    expect(text).toContain('ask them')
    // No runId handed back: nothing was launched.
    expect(text).not.toContain('runId')
  })

  it('rejects a script that names no model, before any run starts', async () => {
    const app = new Hono()
    app.route('/api/workflow-mcp', workflowMcpRoutes())
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
    const client = new Client({ name: 'workflow-model-test', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/api/workflow-mcp`),
      ),
    )
    closeCallbacks.push(() => client.close())

    // agentType is present, so this gets past the first gate; the model is not.
    const script = [
      "export const meta = { name: 'no-model', description: 'x', phases: [{ title: 'P' }] }",
      "phase('P')",
      "return await agent('do a thing', { agentType: 'codex', label: 'thing' })",
    ].join('\n')

    const result = (await client.callTool({
      name: WORKFLOW_MCP_TOOL_NAME,
      arguments: { script, agents_chosen_by_user: true },
    })) as { isError?: boolean; content?: Array<{ text?: string }> }

    expect(result.isError).toBe(true)
    const text = result.content?.[0]?.text ?? ''
    expect(text).toContain('must also name a model')
    // 'default' has to be offered, or the only way past the gate is to invent an id.
    expect(text).toContain("model: 'default'")
    // Nothing was launched.
    expect(text).not.toContain('runId')
  })

  it('refuses to start until the caller states the user chose the agents', async () => {
    const app = new Hono()
    app.route('/api/workflow-mcp', workflowMcpRoutes())
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
    const client = new Client({ name: 'workflow-consent-test', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/api/workflow-mcp`),
      ),
    )
    closeCallbacks.push(() => client.close())

    // A perfectly valid script — every agent names an agentType. What is missing
    // is the user having been asked.
    const script = [
      "export const meta = { name: 'unasked', description: 'x', phases: [{ title: 'P' }] }",
      "phase('P')",
      "return await agent('do a thing', { agentType: 'codex', label: 'thing' })",
    ].join('\n')

    const result = (await client.callTool({
      name: WORKFLOW_MCP_TOOL_NAME,
      arguments: { script },
    })) as { isError?: boolean; content?: Array<{ text?: string }> }

    expect(result.isError).toBe(true)
    const text = result.content?.[0]?.text ?? ''
    expect(text).toContain('Ask the user')
    expect(text).toContain('codex, operon')
    // The model is part of the same question — the consent gate has to say so,
    // and name the tool that lists the choices.
    expect(text).toContain('which MODEL each step should use')
    expect(text).toContain(LIST_MODELS_TOOL_NAME)
    // Steers away from the in-app agent unless it was asked for.
    expect(text).toContain('only if the user asks for it')
    expect(text).toContain('agents_chosen_by_user: true')
    expect(text).not.toContain('runId')
  })
})
