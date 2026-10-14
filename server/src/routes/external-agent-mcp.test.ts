import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildExternalAgentMcpServer } from './external-agent-mcp.js'

const handlers = vi.hoisted(() => ({ create: vi.fn(), send: vi.fn(), status: vi.fn(), stop: vi.fn() }))
vi.mock('../services/external-agent.js', () => ({
  createExternalAgent: handlers.create, sendExternalAgent: handlers.send,
  getExternalAgentStatus: handlers.status, stopExternalAgent: handlers.stop,
}))
vi.mock('../services/ai/providers.js', () => ({
  getProviders: () => [{ id: 'codex', available: true }],
  getProviderModels: async () => ({
    models: [{ modelId: 'fresh-model', name: 'Fresh Model' }, { modelId: 'mini', name: 'Mini' }],
    currentModelId: 'fresh-model',
    configOptions: [
      { category: 'model', options: [{ value: 'fresh-model', name: 'Fresh Model', supportedEffortLevels: ['low', 'high', 'max'] }, { value: 'mini', name: 'Mini' }] },
      { category: 'thought_level', currentValue: 'medium', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
    ],
  }),
}))
vi.mock('../services/ai/provider-models-cache.js', () => ({ warmAllProviders: async () => {} }))

describe('ExternalAgent MCP', () => {
  let client: Client
  beforeEach(async () => {
    vi.clearAllMocks()
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    const server = buildExternalAgentMcpServer(['codex'], 42)
    client = new Client({ name: 'external-test', version: '1' })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
  })
  afterEach(async () => { await client.close() })

  it('uses the dynamic provider catalog and rejects missing user choices before dispatch', async () => {
    const catalog = await client.callTool({ name: 'external_agent_list_models', arguments: { agentTypes: ['codex'] } })
    expect(JSON.stringify(catalog)).toContain('fresh-model')
    const input = { agent_type: 'codex', prompt: 'Review', description: 'Review' }
    expect((await client.callTool({ name: 'external_agent_run', arguments: input })).isError).toBe(true)
    expect((await client.callTool({ name: 'external_agent_run', arguments: { ...input, model: 'fresh-model' } })).isError).toBe(true)
    expect(handlers.create).not.toHaveBeenCalled()
    handlers.create.mockResolvedValue({ agent_id: 'ext-10', chat_id: 10 })
    await client.callTool({ name: 'external_agent_run', arguments: { ...input, model: 'fresh-model', selection_confirmed: true } })
    expect(handlers.create).toHaveBeenCalledWith({ parent: { chatId: 42 }, providerId: 'codex', model: 'fresh-model', prompt: 'Review', description: 'Review' })
  })

  it('lists effort levels per model and passes the chosen one on', async () => {
    const catalog = await client.callTool({ name: 'external_agent_list_models', arguments: { agentTypes: ['codex'] } })
    const [entry] = JSON.parse((catalog.content as Array<{ text: string }>)[0].text).agents
    expect(entry.efforts).toEqual(['low', 'medium', 'high'])
    expect(entry.currentEffort).toBe('medium')
    // Narrowed to the agent's own levels, like the composer's menu; a model without its own list takes them all.
    expect(entry.models).toEqual([{ id: 'fresh-model', name: 'Fresh Model', efforts: ['low', 'high'] }, { id: 'mini', name: 'Mini' }])
    handlers.create.mockResolvedValue({ agent_id: 'ext-10', chat_id: 10 })
    await client.callTool({ name: 'external_agent_run', arguments: {
      agent_type: 'codex', model: 'fresh-model', effort: 'high', selection_confirmed: true, prompt: 'Review', description: 'Review',
    } })
    expect(handlers.create.mock.calls[0][0].effort).toBe('high')
  })

  it('accepts an explicitly chosen default and does not ask again when following up', async () => {
    handlers.create.mockResolvedValue({ agent_id: 'ext-10', chat_id: 10 })
    await client.callTool({ name: 'external_agent_run', arguments: {
      agent_type: 'codex', model: 'default', selection_confirmed: true, prompt: 'Review', description: 'Review',
    } })
    expect(handlers.create.mock.calls[0][0].model).toBe('default')
    handlers.send.mockReturnValue({ status: 'queued', agent_id: 'ext-10' })
    await client.callTool({ name: 'external_agent_send', arguments: { agent_id: 'ext-10', prompt: 'Fix it' } })
    expect(handlers.send).toHaveBeenCalledWith(42, 'ext-10', 'Fix it')
  })
})
