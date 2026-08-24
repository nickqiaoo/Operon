/**
 * IM chat MCP server — Streamable HTTP transport (MCP spec 2024-11-05).
 *
 * Exposes the minimal
 * tool surface needed for IM: send_message, check_messages, read_history.
 * Tasks / uploads deferred to v2 (see im-first-agent-platform.md).
 *
 * Mounted at POST /api/im-chat-mcp. Agent identity comes from the X-Agent-Id
 * request header (set per-agent in buildMcpServersForCli). Falls back to
 * ?agentId=N query param for legacy callers.
 */

import { Hono } from 'hono'
import type { IMProviderRegistry } from '../gateway/im/registry.js'
import {
  ImChatService,
  type ImChatStorage,
  type MCPContentPart,
} from '../services/agent-comm/im-chat-service.js'

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

const BASE_TOOLS = [
  {
    name: 'send_message',
    description:
      "Send a message to an IM channel, DM, or thread. Reuse the target from received messages. Format: '<source>:<channel>' (e.g. 'slack:C123ABC') or '<source>:<channel>:<sourceTs>' for a thread anchored on a prior message (sourceTs = the platform-native id shown in the `msg=` field of received messages).",
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description:
            "Where to send. Reuse the value of `target=` from a received message header. Format: '<source>:<channel>' or '<source>:<channel>:<sourceTs>'.",
        },
        content: { type: 'string', description: 'The message content (plain text or source-appropriate mrkdwn).' },
      },
      required: ['target', 'content'],
    },
  },
  {
    name: 'check_messages',
    description:
      "Check for new unread messages across all IM channels you're in. Returns immediately. Advances your read cursor, so the same message won't appear again. Call freely at natural breakpoints.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_history',
    description:
      "Read paginated message history for a target. Does not advance the cursor. Use `before` (id) for backward pagination, `after` for catching up on unread.",
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: "The target to read from — e.g. 'slack:C123ABC'.",
        },
        limit: {
          type: 'number',
          description: 'Max messages (default 50, max 100).',
          default: 50,
        },
        before: { type: 'number', description: 'Return messages with id < before.' },
        after: { type: 'number', description: 'Return messages with id > after.' },
      },
      required: ['target'],
    },
  },
]

async function handleOne(
  req: JsonRpcRequest,
  bridge: ImChatService,
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null

  switch (req.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          // Tools only — declaring resources/prompts here makes some MCP
          // clients (kimi / Python httpx) probe those endpoints and open a
          // GET SSE stream for subscriptions. Our router returns 405 on
          // GET, which those clients treat as a broken server and drop.
          capabilities: { tools: {} },
          serverInfo: { name: 'im_chat', version: '1.0.0' },
        },
      }

    case 'tools/list': {
      return { jsonrpc: '2.0', id, result: { tools: BASE_TOOLS } }
    }

    // Some clients (kimi / Python MCP SDK) probe these after initialize and
    // silently drop the server if they receive -32601. Return empty lists.
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
        const content = await dispatch(params.name, args, bridge)
        return { jsonrpc: '2.0', id, result: { content } }
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

function asText(text: string): MCPContentPart[] {
  return [{ type: 'text', text }]
}

async function dispatch(
  name: string,
  args: Record<string, unknown>,
  bridge: ImChatService,
): Promise<MCPContentPart[]> {
  switch (name) {
    case 'send_message': {
      const target = String(args.target)
      const result = await bridge.sendMessage(target, String(args.content))
      if (!result.sourceTs) return asText(`Message sent to ${target}.`)
      return asText(`Message sent to ${target}. Message ID: ${result.sourceTs}`)
    }
    case 'check_messages': {
      const parts = await bridge.checkMessages()
      return parts.length === 0 ? asText('No new messages.') : parts
    }
    case 'read_history': {
      const limit = typeof args.limit === 'number' ? args.limit : 50
      const result = await bridge.readHistory(String(args.target), limit, {
        before: typeof args.before === 'number' ? args.before : undefined,
        after: typeof args.after === 'number' ? args.after : undefined,
      })
      if (result.parts.length === 0) return asText('No messages in this target.')
      const header: MCPContentPart = {
        type: 'text',
        text: `## History for ${args.target}`,
      }
      const footer: MCPContentPart | null = result.hasMore && result.oldestId != null
        ? { type: 'text', text: `--- More available. Use before=${result.oldestId} for older. ---` }
        : null
      return footer ? [header, ...result.parts, footer] : [header, ...result.parts]
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

export function imChatMcpRoutes(
  storage: ImChatStorage,
  registry: IMProviderRegistry,
) {
  const router = new Hono()

  router.get('/', () =>
    new Response(null, { status: 405, headers: { Allow: 'POST', 'Content-Type': 'application/json' } }),
  )

  router.post('/', async (c) => {
    const headerAgent = c.req.header('x-agent-id')
    const agentId = parseInt(headerAgent ?? c.req.query('agentId') ?? '0', 10)
    if (!agentId) return c.json({ error: 'X-Agent-Id header required' }, 400)
    const bridge = new ImChatService(storage, registry, agentId)
    const body = await c.req.json<JsonRpcRequest | JsonRpcRequest[]>()
    const methods = Array.isArray(body) ? body.map((r) => r.method).join(',') : body.method
    console.log(`[im-chat-mcp] agent=${agentId} method=${methods}`)

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
