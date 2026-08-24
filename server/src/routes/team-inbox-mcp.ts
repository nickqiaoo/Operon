/**
 * Team inbox MCP server — agent-to-agent point-to-point messaging.
 *
 * Streamable HTTP transport (MCP spec 2024-11-05).
 *
 * Mounted at POST /api/team-inbox-mcp. Caller must supply X-Agent-Id (sender's
 * agents.id) and X-Agent-Session-Id (the sender binding's session key, used
 * to scope team peer queries by project/team_label).
 *
 * Task-team sessions are the live consumer (injected by agent-orchestrator when
 * a task binding carries a team label). The Linear binding scope this server was
 * originally built for is retired — its wake-up branch in TeamInboxService is
 * unreachable now that no Linear binding is ever created.
 */

import { Hono } from 'hono'
import type {
  AgentBindingStorageAdapter,
  ChannelStorageAdapter,
} from '../storage/interface.js'
import { TeamInboxService } from '../services/agent-comm/team-inbox-service.js'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

const TOOLS = [
  {
    name: 'send_to_agent',
    description:
      "Send a direct, point-to-point message to another agent. The content is private — only the recipient sees it (not any feed or channel). Use it to coordinate with teammates working on related tasks — request information, hand off context, sync on a dependency. Reach the recipient by their handle from list_team_peers (e.g. 'coder@task-7'). Works regardless of the recipient's status: if active, the message is steered into their live stream; if idle, they're woken to read it via inbox_check. The handle pins the message to that agent's specific task session — their sessions on other tasks won't see it.",
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description:
            "Recipient handle in the form 'name@<taskRef>' (copy verbatim from list_team_peers, e.g. 'coder@task-7').",
        },
        content: { type: 'string', description: 'The message text.' },
      },
      required: ['to', 'content'],
    },
  },
  {
    name: 'inbox_check',
    description:
      "Check your personal inbox for unread direct messages from other agents. Returns only messages addressed to your current task session (or broadcasts to your agent). Advances a per-session cursor, so the same message won't appear again here, and a sibling session of yours on a different task won't accidentally consume it. Call freely at natural breakpoints, especially after seeing a `[System notification: ...new direct message...]` injection.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max messages (default 50, max 200).', default: 50 },
      },
    },
  },
  {
    name: 'inbox_read_history',
    description:
      "Read past inbox messages without advancing the cursor. Useful when a teammate references something they sent earlier. Filter by peer name to see only one conversation. Returns newest-first.",
    inputSchema: {
      type: 'object',
      properties: {
        peer: { type: 'string', description: 'Filter to messages from this agent name.' },
        before: { type: 'number', description: 'Return messages with id < before (backward pagination).' },
        limit: { type: 'number', description: 'Max messages (default 50, max 200).', default: 50 },
      },
    },
  },
  {
    name: 'list_team_peers',
    description:
      "List the other agents currently working in the same project under the same team label. Use this to discover who you can coordinate with via send_to_agent. Each peer is shown as a `handle [status=...] — description` line; the handle (e.g. 'coder@task-7') is the exact string to pass as send_to_agent.to.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_agents',
    description:
      "Global directory of all known agents (names + role descriptions). Lets you reach anyone by name with send_to_agent — they may not be working on a task right now, in which case the message waits in their inbox until they next start a session.",
    inputSchema: { type: 'object', properties: {} },
  },
]

async function handleOne(
  req: JsonRpcRequest,
  bridge: TeamInboxService,
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null

  switch (req.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'team_inbox', version: '1.0.0' },
        },
      }

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } }

    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } }
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } }
    case 'resources/templates/list':
      return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } }
    case 'mcpServer/elicitation/request':
      return { jsonrpc: '2.0', id, result: {} }

    case 'tools/call': {
      const params = req.params as { name: string; arguments: Record<string, unknown> }
      const args = params.arguments ?? {}
      try {
        const text = await dispatch(params.name, args, bridge)
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `Error: ${message}` }], isError: true },
        }
      }
    }

    default:
      if (req.id === undefined || req.id === null) return null
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      }
  }
}

async function dispatch(
  name: string,
  args: Record<string, unknown>,
  bridge: TeamInboxService,
): Promise<string> {
  switch (name) {
    case 'send_to_agent': {
      const to = String(args.to)
      const content = String(args.content)
      const result = await bridge.sendToAgent({ to, content })
      const verb =
        result.delivered === 'injected'
          ? 'delivered'
          : result.delivered === 'woken'
            ? 'queued + recipient woken (will read on wake)'
            : 'queued (recipient offline; will read on next wake)'
      return `Message ${verb} → ${to} (id=${result.messageId}).`
    }
    case 'inbox_check': {
      const limit = typeof args.limit === 'number' ? args.limit : 50
      const messages = await bridge.inboxCheck(limit)
      return messages.length === 0
        ? 'No new direct messages.'
        : messages.map((m) => m.formatted).join('\n')
    }
    case 'inbox_read_history': {
      const limit = typeof args.limit === 'number' ? args.limit : 50
      const peer = typeof args.peer === 'string' ? args.peer : undefined
      const before = typeof args.before === 'number' ? args.before : undefined
      const result = await bridge.inboxReadHistory({ peer, before, limit })
      if (result.messages.length === 0) return 'No history.'
      const footer = result.hasMore
        ? `\n\n--- ${result.messages.length} shown. More available. Use before=${result.messages[result.messages.length - 1].id} for older. ---`
        : ''
      return result.messages.map((m) => m.formatted).join('\n') + footer
    }
    case 'list_team_peers': {
      const peers = await bridge.listTeamPeers()
      if (peers.length === 0) return 'No other agents currently active in this project/team.'
      return peers
        .map((p) => `${p.handle} [status=${p.status}] — ${p.description || '(no description)'}`)
        .join('\n')
    }
    case 'list_agents': {
      const agents = await bridge.listAgents()
      if (agents.length === 0) return 'No agents registered.'
      return agents.map((a) => `@${a.name} — ${a.description || '(no description)'}`).join('\n')
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

export function teamInboxMcpRoutes(
  storage: AgentBindingStorageAdapter
    & Pick<ChannelStorageAdapter, 'getAgent' | 'getAgentByName' | 'listAgents'>,
) {
  const router = new Hono()

  router.get('/', () =>
    new Response(null, { status: 405, headers: { Allow: 'POST', 'Content-Type': 'application/json' } }),
  )

  router.post('/', async (c) => {
    const headerAgent = c.req.header('x-agent-id')
    const agentId = parseInt(headerAgent ?? c.req.query('agentId') ?? '0', 10)
    const sessionId = c.req.header('x-agent-session-id') ?? c.req.query('agentSessionId') ?? ''
    if (!agentId) return c.json({ error: 'X-Agent-Id header required' }, 400)
    if (!sessionId) return c.json({ error: 'X-Agent-Session-Id header required' }, 400)

    const bridge = new TeamInboxService(storage, agentId, sessionId)
    const body = await c.req.json<JsonRpcRequest | JsonRpcRequest[]>()
    const methods = Array.isArray(body) ? body.map((r) => r.method).join(',') : body.method
    console.log(`[team-inbox-mcp] agent=${agentId} method=${methods}`)

    if (Array.isArray(body)) {
      const responses = (await Promise.all(body.map((r) => handleOne(r, bridge)))).filter(
        (r): r is JsonRpcResponse => r !== null,
      )
      if (!responses.length)
        return new Response(null, { status: 202, headers: { 'Content-Type': 'application/json' } })
      return c.json(responses)
    }

    const response = await handleOne(body, bridge)
    if (!response)
      return new Response(null, { status: 202, headers: { 'Content-Type': 'application/json' } })
    return c.json(response)
  })

  return router
}
