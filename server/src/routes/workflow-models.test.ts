/**
 * `ListAgentModels` sizing behaviour.
 *
 * The catalog is a menu a human is about to choose from, and one agent can be
 * enormous: `operon` runs on every model of every LLM provider the user holds a
 * key for, which for a single OpenRouter key is several hundred. These cases pin
 * how a list that big degrades — a truncated list presented as a whole one is the
 * failure mode worth guarding against, since it makes models the user owns look
 * unavailable.
 *
 * The provider layer is mocked: what matters here is the shaping, not whether a
 * CLI answered.
 */
import { describe, it, expect, vi } from 'vitest'
import type { AddressInfo } from 'node:net'

const VENDORS = ['anthropic', 'openai', 'google', 'meta-llama', 'mistralai']
const MANY = Array.from({ length: 320 }, (_, i) => ({
  modelId: `openrouter/${VENDORS[i % VENDORS.length]}/model-${i}`,
  name: `${VENDORS[i % VENDORS.length]} model ${i}`,
}))

vi.mock('../services/ai/providers.js', () => ({
  // The route reads the installed agents from here per request, rather than
  // taking them off the URL.
  getProviders: () => [{ id: 'codex', available: true }],
  getProviderModels: async (id: string) =>
    id === 'custom'
      ? { models: MANY, currentModelId: 'openrouter/anthropic/claude-sonnet-4-6', modelsPending: false }
      : {
          models: [{ modelId: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' }],
          currentModelId: 'gpt-5.6-sol',
          modelsPending: false,
        },
}))
vi.mock('../services/ai/provider-models-cache.js', () => ({ warmAllProviders: async () => {} }))

const { serve } = await import('@hono/node-server')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
const { Hono } = await import('hono')
const { LIST_MODELS_TOOL_NAME, workflowMcpRoutes } = await import('./workflow-mcp.js')

interface Entry {
  agentType: string
  currentModel?: string
  models?: Array<{ id: string }>
  totalModels?: number
  groups?: Array<{ prefix: string; count: number }>
  sample?: string[]
  hint?: string
}

async function listModels(args: Record<string, unknown>): Promise<{ agents: Entry[]; bytes: number }> {
  const app = new Hono()
  app.route('/api/workflow-mcp', workflowMcpRoutes())
  const server = serve({ fetch: app.fetch, port: 0 })
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once('listening', resolve)))
  const { port } = server.address() as AddressInfo
  const client = new Client({ name: 'workflow-models-test', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/workflow-mcp`)),
  )
  const result = (await client.callTool({ name: LIST_MODELS_TOOL_NAME, arguments: args })) as {
    content?: Array<{ text?: string }>
  }
  await client.close()
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  const text = result.content?.[0]?.text ?? '{}'
  return { agents: (JSON.parse(text) as { agents: Entry[] }).agents, bytes: text.length }
}

const operonOf = (agents: Entry[]): Entry => agents.find((a) => a.agentType === 'operon')!

describe('ListAgentModels', () => {
  it('lists a short agent in full', async () => {
    const { agents } = await listModels({})
    const codex = agents.find((a) => a.agentType === 'codex')!
    expect(codex.models?.map((m) => m.id)).toEqual(['gpt-5.6-sol'])
    expect(codex.groups).toBeUndefined()
  })

  it('withholds a huge list and offers families to ask about instead', async () => {
    const { agents, bytes } = await listModels({})
    const operon = operonOf(agents)
    // The full list is NOT sent — that is the whole point.
    expect(operon.models).toBeUndefined()
    expect(operon.totalModels).toBe(320)
    expect(operon.groups?.map((g) => g.prefix)).toContain('openrouter/anthropic')
    expect(operon.hint).toContain('Ask the user which family')
    // Still names the fallback, so 'default' remains reachable without choosing.
    expect(operon.currentModel).toBe('openrouter/anthropic/claude-sonnet-4-6')
    // 320 models listed outright would be ~20KB.
    expect(bytes).toBeLessThan(3_000)
  })

  it('narrows to a full list once the query is specific enough', async () => {
    const { agents } = await listModels({ query: 'model-7' })
    const operon = operonOf(agents)
    expect(operon.groups).toBeUndefined()
    expect(operon.models?.length).toBe(11) // model-7, -70..-79
    expect(operon.models?.every((m) => m.id.includes('model-7'))).toBe(true)
  })

  it('shows a window rather than a one-item family menu', async () => {
    // Every match shares a prefix here, so groups would offer the user exactly
    // the thing they just picked — a dead end. A window is the only useful answer.
    const { agents } = await listModels({ query: 'anthropic' })
    const operon = operonOf(agents)
    expect(operon.groups).toBeUndefined()
    expect(operon.models?.length).toBe(25)
    expect(operon.totalModels).toBe(64)
    expect(operon.hint).toContain('Showing 25 of 64')
  })

  it('says so when nothing matches, instead of returning a bare empty list', async () => {
    const { agents } = await listModels({ query: 'no-such-model' })
    const operon = operonOf(agents)
    expect(operon.models).toEqual([])
    expect(operon.hint).toContain('No model matches')
  })
})
