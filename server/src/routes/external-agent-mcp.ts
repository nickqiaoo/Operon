/** Server-owned, resumable external agent conversations. */
import { Hono, type Context } from 'hono'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { getProviders } from '../services/ai/providers.js'
import { agentModelCatalog } from '../services/agents/model-catalog.js'
import { createExternalAgent, sendExternalAgent, stopExternalAgent, getExternalAgentStatus } from '../services/external-agent.js'
import { createChatWorkspace, type ChatWorkspaceStorage } from '../services/chat-workspace.js'
import { serveMcpOverHono, withCodexElicitationFallback } from './mcp-http.js'
import { resolveMcpCallerChat } from './mcp-caller.js'
import { getSaasConfig } from '../gateway/saas/config.js'
import { delegationRequest, listDelegationNodes } from '../services/delegation-transport.js'
import { isRemoteAgentId, remoteAgentStatus, sendRemoteAgent, stopRemoteAgent } from '../services/remote-agents.js'
import { DELEGATION_NODE_ID } from '@shared/delegations'

import { agentTypeForProvider, providerForAgentType, SUPPORTED_EXTERNAL_AGENT_IDS } from '@shared/external-agent'
export { SUPPORTED_EXTERNAL_AGENT_IDS }

const MODEL_TOOL = 'external_agent_list_models'
const requiredText = (args: Record<string, unknown>, key: string): string => {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`)
  return value.trim()
}

export function buildExternalAgentMcpServer(availableAgents: string[], parentChatId: number, storage: ChatWorkspaceStorage): Server {
  const server = new Server({ name: 'external_agent', version: '2.0.0' }, { capabilities: { tools: {} } })
  const agentId = { type: 'string', description: 'agent_id returned by external_agent_run. Reuses its existing conversation.' }
  const prompt = { type: 'string', description: 'Instructions for this turn.' }
  // Other machines of the account are reachable once this one is connected to Remote.
  const remote = !!getSaasConfig().nodeToken
  const target = { type: 'string', description: 'Run on another machine: a nodeId from external_agent_list_targets. Omit for this machine.' }
  const tools: Tool[] = [
    ...(remote ? [{
      name: 'external_agent_list_targets',
      description: 'List the other machines on this account an external agent can run on. A machine must be paired with this one and allow it in its Remote settings; an unpaired one (paired: false) cannot be reached until the user pairs them in Settings → Remote.',
      inputSchema: { type: 'object' as const, properties: {} },
    }] : []),
    {
      name: MODEL_TOOL,
      description: `List model choices for the selected agent types. Omit agentTypes for a combined agent and model catalog. Preserve choices already given. Large lists return groups; narrow them with query.${remote ? ' With target_node_id, lists that machine\'s agents and models, and its workspaces.' : ''}`,
      inputSchema: { type: 'object', properties: {
        agentTypes: { type: 'array', items: { type: 'string' }, description: 'Only these agents; omit for all available external agents.' },
        query: { type: 'string', description: 'Filter model IDs and names, e.g. sonnet or gpt.' },
        ...(remote ? { target_node_id: target } : {}),
      } },
    },
    {
      name: 'external_agent_run',
      description: `Launch a child agent in an Operon workspace on the agent loop host. The child does not inherit the caller's environments.${remote ? " Set target_node_id to run in a paired Operon node's workspace." : ""} See /operon-external-agent. Use ${MODEL_TOOL} to look up agents and their models. Ask the user for any missing choice. Both agent_type and model are required; model:'default' means the user accepts that agent's own model. Set selection_confirmed:true only after the user chose. Include a self-contained prompt: the child cannot see this conversation. Returns immediately; results arrive here automatically. If your next step depends on the result, end this turn and wait. Do not poll. Follow up using external_agent_send with the returned agent_id.`,
      inputSchema: { type: 'object', properties: {
        // Another machine has agents of its own.
        agent_type: remote ? { type: 'string', description: `This machine: ${availableAgents.join(', ')}. Another machine: one ${MODEL_TOOL} lists for it.` } : { type: 'string', enum: availableAgents }, prompt,
        description: { type: 'string', description: 'Short task title.' },
        model: { type: 'string', description: `An ID from ${MODEL_TOOL}, or 'default' explicitly accepted by the user.` },
        effort: { type: 'string', description: `Reasoning effort, one of the levels ${MODEL_TOOL} lists for that agent and model. Only when the user asked for one; omit to use the agent's own.` },
        selection_confirmed: { type: 'boolean', description: 'True only when the user has chosen both the agent and model.' },
        workspace_id: { type: 'integer', description: remote
          ? "Workspace the agent works in. This machine: one in this conversation's project (e.g. from workspace_create); omit for the parent chat's project workspace on the host. Another machine: one of the workspaces " + MODEL_TOOL + ' lists for it; omit only when it has one.'
          : "Workspace the agent works in, in this conversation's project (e.g. one from workspace_create). Omit for the parent chat's project workspace on the host." },
        ...(remote ? { target_node_id: target } : {}),
      }, required: ['agent_type', 'prompt', 'description', 'model', 'selection_confirmed'] },
    },
    {
      name: 'external_agent_send',
      description: 'Continue an existing external agent conversation. Keeps its context and model. No new model question is needed. Never use it to answer a question the agent asked the user: tell the user instead. Steers a running agent when supported; otherwise uses runtime followup when supported. Optional delivery selects auto, strict steer, or followup. Unsupported operations fail; uncertain delivery must not be resent. Output stays on the active stream; one result arrives after that stream ends. The result will arrive automatically, including when the user continues from the child tab. End your turn if waiting on its result.',
      inputSchema: { type: 'object', properties: { agent_id: agentId, prompt, delivery: { type: 'string', enum: ['auto', 'steer', 'followup'], default: 'auto' } }, required: ['agent_id', 'prompt'] },
    },
    {
      name: 'external_agent_status', description: 'Inspect an external agent and its latest result when needed. Do not repeatedly poll: results are delivered automatically.',
      inputSchema: { type: 'object', properties: { agent_id: agentId }, required: ['agent_id'] },
    },
    {
      name: 'external_agent_stop', description: 'Stop the current execution. Pending native input follows the provider cancellation behavior. Keeps the child conversation available for follow-up. Closing its tab does not stop execution.',
      inputSchema: { type: 'object', properties: { agent_id: agentId }, required: ['agent_id'] },
    },
    {
      name: 'workspace_create',
      description: "On the loop host, create a workspace in this conversation's project: a new branch in its own worktree, shown in the sidebar. Only when the user wants one, or agreed to one because the work needs its own branch. It only creates the workspace; to have an external agent work there, pass the returned workspace_id to external_agent_run.",
      inputSchema: { type: 'object', properties: {
        name: { type: 'string', description: 'Short, e.g. "login-redirect"; it also names the branch.' },
        base_branch: { type: 'string', description: "What the branch starts from; the repository's default branch if left out." },
      }, required: ['name'] },
    },
  ]
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
    try {
      const name = req.params.name
      const targetNodeId = remoteTarget(args.target_node_id)
      if (name === 'external_agent_list_targets') {
        const machines = (await listDelegationNodes()).filter((machine) => !machine.current)
        return json({ machines: machines.map(({ nodeId, label, online, paired }) => ({ nodeId, label, online, paired: paired === true })) })
      }
      if (name === MODEL_TOOL) {
        const requested = Array.isArray(args.agentTypes) ? args.agentTypes.filter((id): id is string => typeof id === 'string') : []
        if (targetNodeId) {
          const params = new URLSearchParams()
          for (const id of requested) params.append('provider', providerForAgentType(id))
          if (typeof args.query === 'string' && args.query.trim()) params.set('query', args.query.trim())
          return json(await delegationRequest(targetNodeId, `/api/delegations/catalog${params.size ? `?${params}` : ''}`))
        }
        if (requested.some((id) => !availableAgents.includes(id))) throw new Error(`Available agents: ${availableAgents.join(', ')}`)
        return json({ agents: await agentModelCatalog(requested.length ? requested : availableAgents,
          typeof args.query === 'string' ? args.query.trim() || undefined : undefined, MODEL_TOOL) })
      }
      if (!Number.isSafeInteger(parentChatId) || parentChatId <= 0) throw new Error('This tool requires a parent chat context')
      if (name === 'external_agent_run') {
        const agentType = requiredText(args, 'agent_type')
        const providerId = providerForAgentType(agentType)
        const model = requiredText(args, 'model')
        if (!targetNodeId && !availableAgents.includes(agentTypeForProvider(providerId))) throw new Error(`Available agents: ${availableAgents.join(', ')}`)
        if (args.selection_confirmed !== true) throw new Error(`Call ${MODEL_TOOL} and ask the user to choose the agent and model, then set selection_confirmed:true.`)
        const effort = typeof args.effort === 'string' && args.effort.trim() ? args.effort.trim() : undefined
        if (args.workspace_id !== undefined && !(Number.isSafeInteger(args.workspace_id) && (args.workspace_id as number) > 0)) {
          throw new Error('workspace_id must be a workspace id')
        }
        const workspaceId = args.workspace_id as number | undefined
        return json(await createExternalAgent({
          parent: { chatId: parentChatId, ...(workspaceId && !targetNodeId ? { workspaceId } : {}) }, providerId, model, effort,
          prompt: requiredText(args, 'prompt'), description: requiredText(args, 'description'),
          ...(targetNodeId ? { remote: { nodeId: targetNodeId, workspaceId } } : {}),
        }))
      }
      if (name === 'workspace_create') {
        const base = typeof args.base_branch === 'string' && args.base_branch.trim() ? args.base_branch.trim() : undefined
        return json(await createChatWorkspace(storage, parentChatId, { name: requiredText(args, 'name'), ...(base ? { base } : {}) }))
      }
      const id = requiredText(args, 'agent_id')
      const delivery = args.delivery === 'steer' || args.delivery === 'followup' ? args.delivery : 'auto'
      // An agent started on another machine: the same calls, made there.
      const remoteAgent = isRemoteAgentId(id)
      if (name === 'external_agent_send') {
        const prompt = requiredText(args, 'prompt')
        return json(remoteAgent ? await sendRemoteAgent(parentChatId, id, prompt, delivery) : await sendExternalAgent(parentChatId, id, prompt, delivery))
      }
      if (name === 'external_agent_status') return json(remoteAgent ? await remoteAgentStatus(parentChatId, id) : getExternalAgentStatus(parentChatId, id))
      if (name === 'external_agent_stop') return json(remoteAgent ? await stopRemoteAgent(parentChatId, id) : stopExternalAgent(parentChatId, id))
      throw new Error(`Unknown tool: ${name}`)
    } catch (error) {
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
    }
  })
  return withCodexElicitationFallback(server)
}

function remoteTarget(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || !DELEGATION_NODE_ID.test(value)) throw new Error('target_node_id must be a nodeId from external_agent_list_targets')
  return value
}

export function externalAgentMcpRoutes(storage: ChatWorkspaceStorage) {
  const router = new Hono()
  const handle = async (c: Context) => {
    const caller = await resolveMcpCallerChat(c, 'chatId')
    if (!caller.ok) return caller.response
    const available = getProviders().filter((p) => p.available &&
      SUPPORTED_EXTERNAL_AGENT_IDS.includes(p.id as (typeof SUPPORTED_EXTERNAL_AGENT_IDS)[number])).map((p) => agentTypeForProvider(p.id))
    return serveMcpOverHono(c, buildExternalAgentMcpServer(available, caller.chatId ?? 0, storage), caller.body)
  }
  router.post('/', handle)
  router.get('/', handle)
  router.delete('/', handle)
  return router
}
