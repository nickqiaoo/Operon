/** Server-owned, resumable external agent conversations. */
import { Hono, type Context } from 'hono'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { getProviders } from '../services/ai/providers.js'
import { agentModelCatalog } from '../services/agents/model-catalog.js'
import { createExternalAgent, sendExternalAgent, stopExternalAgent, getExternalAgentStatus } from '../services/external-agent.js'
import { serveMcpOverHono, withCodexElicitationFallback } from './mcp-http.js'
import { resolveMcpCallerChat } from './mcp-caller.js'

export const SUPPORTED_EXTERNAL_AGENT_IDS = ['codex', 'claude-code', 'opencode', 'kimi', 'cursor', 'grok', 'copilot', 'antigravity'] as const

const MODEL_TOOL = 'external_agent_list_models'
const requiredText = (args: Record<string, unknown>, key: string): string => {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`)
  return value.trim()
}

export function buildExternalAgentMcpServer(availableAgents: string[], parentChatId: number): Server {
  const server = new Server({ name: 'external_agent', version: '2.0.0' }, { capabilities: { tools: {} } })
  const agentId = { type: 'string', description: 'agent_id returned by external_agent_run. Reuses its existing conversation.' }
  const prompt = { type: 'string', description: 'Instructions for this turn.' }
  const tools: Tool[] = [
    {
      name: MODEL_TOOL,
      description: 'Dynamically list available external agents, their current models and model choices. Before creating an agent, query this and ask the user to choose the agent and model. Preserve choices already given. Large lists return groups; narrow them with query.',
      inputSchema: { type: 'object', properties: {
        agentTypes: { type: 'array', items: { type: 'string' }, description: 'Only these agents; omit for all available external agents.' },
        query: { type: 'string', description: 'Filter model IDs and names, e.g. sonnet or gpt.' },
      } },
    },
    {
      name: 'external_agent_run',
      description: `Delegate to an external agent in a new chat tab. See /operon-external-agent. First call ${MODEL_TOOL} and ask the user which agent AND model to use; do not pick silently or re-ask choices already given. Both agent_type and model are required; model:'default' means the user accepts that agent's own model. Set selection_confirmed:true only after the user chose. Include a self-contained prompt: the child cannot see this conversation. Returns immediately; results arrive here automatically. If your next step depends on the result, end this turn and wait. Do not poll. Follow up using external_agent_send with the returned agent_id.`,
      inputSchema: { type: 'object', properties: {
        agent_type: { type: 'string', enum: availableAgents }, prompt,
        description: { type: 'string', description: 'Short task title.' },
        model: { type: 'string', description: `An ID from ${MODEL_TOOL}, or 'default' explicitly accepted by the user.` },
        selection_confirmed: { type: 'boolean', description: 'True only when the user has chosen both the agent and model.' },
      }, required: ['agent_type', 'prompt', 'description', 'model', 'selection_confirmed'] },
    },
    {
      name: 'external_agent_send',
      description: 'Continue an existing external agent conversation. Keeps its context and model. No new model question is needed. Never use it to answer a question the agent asked the user: tell the user instead. Queues if busy; returns immediately. The result will arrive automatically, including when the user continues from the child tab. End your turn if waiting on its result.',
      inputSchema: { type: 'object', properties: { agent_id: agentId, prompt }, required: ['agent_id', 'prompt'] },
    },
    {
      name: 'external_agent_status', description: 'Inspect an external agent and its latest result when needed. Do not repeatedly poll: results are delivered automatically.',
      inputSchema: { type: 'object', properties: { agent_id: agentId }, required: ['agent_id'] },
    },
    {
      name: 'external_agent_stop', description: 'Stop the current turn and cancel queued messages. Keeps the child conversation available for follow-up. Closing its tab does not stop execution.',
      inputSchema: { type: 'object', properties: { agent_id: agentId }, required: ['agent_id'] },
    },
  ]
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
    try {
      const name = req.params.name
      if (name === MODEL_TOOL) {
        const requested = Array.isArray(args.agentTypes) ? args.agentTypes.filter((id): id is string => typeof id === 'string') : []
        if (requested.some((id) => !availableAgents.includes(id))) throw new Error(`Available agents: ${availableAgents.join(', ')}`)
        return json({ agents: await agentModelCatalog(requested.length ? requested : availableAgents,
          typeof args.query === 'string' ? args.query.trim() || undefined : undefined, MODEL_TOOL) })
      }
      if (!Number.isSafeInteger(parentChatId) || parentChatId <= 0) throw new Error('This tool requires a parent chat context')
      if (name === 'external_agent_run') {
        const providerId = requiredText(args, 'agent_type')
        const model = requiredText(args, 'model')
        if (!availableAgents.includes(providerId)) throw new Error(`Available agents: ${availableAgents.join(', ')}`)
        if (args.selection_confirmed !== true) throw new Error(`Call ${MODEL_TOOL} and ask the user to choose the agent and model, then set selection_confirmed:true.`)
        return json(await createExternalAgent({ parentChatId, providerId, model,
          prompt: requiredText(args, 'prompt'), description: requiredText(args, 'description') }))
      }
      const id = requiredText(args, 'agent_id')
      if (name === 'external_agent_send') return json(sendExternalAgent(parentChatId, id, requiredText(args, 'prompt')))
      if (name === 'external_agent_status') return json(getExternalAgentStatus(parentChatId, id))
      if (name === 'external_agent_stop') return json(stopExternalAgent(parentChatId, id))
      throw new Error(`Unknown tool: ${name}`)
    } catch (error) {
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
    }
  })
  return withCodexElicitationFallback(server)
}

export function externalAgentMcpRoutes() {
  const router = new Hono()
  const handle = async (c: Context) => {
    const caller = await resolveMcpCallerChat(c, 'chatId')
    if (!caller.ok) return caller.response
    const available = getProviders().filter((p) => p.available &&
      SUPPORTED_EXTERNAL_AGENT_IDS.includes(p.id as (typeof SUPPORTED_EXTERNAL_AGENT_IDS)[number])).map((p) => p.id)
    return serveMcpOverHono(c, buildExternalAgentMcpServer(available, caller.chatId ?? 0), caller.body)
  }
  router.post('/', handle)
  router.get('/', handle)
  router.delete('/', handle)
  return router
}
