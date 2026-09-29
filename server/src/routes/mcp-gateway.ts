/**
 * Plugin MCP gateway — lets every agent use a plugin MCP server that needs OAuth (or a tool
 * filter / cwd no CLI config can express) without the token ever leaving Operon.
 *
 * `buildMcpServersForCli` hands other agents `/api/mcp-gateway/<name>`; this route answers as an
 * ordinary MCP server and forwards `tools/list` + `tools/call` to the shared upstream connection in
 * services/operon-runtime/mcp-gateway.ts.
 *
 * Not signed in yet is NOT an initialize failure: agent CLIs mark a server that fails to start as
 * broken for the whole session. Instead `tools/list` returns a single `connect_required` tool whose
 * description (and call result) tells the model and the user where to sign in.
 *
 * ## Why stateful
 * Signing in changes the tool list, and agent CLIs list tools once per connection. Rather than
 * change the URL (which would rebuild the whole agent session), each downstream client keeps an MCP
 * session here, and a sign-in change pushes `notifications/tools/list_changed` over its standalone
 * GET stream. Verified 2026-09-29: Claude Code and OpenCode re-list in place. Codex does not — its
 * handler only logs the notification, and a thread's ordinary MCP catalog is fixed until the
 * connection identity changes — so a Codex conversation opened before the first sign-in keeps
 * `connect_required`, whose text says to start a new conversation.
 *
 * Only servers of enabled plugins that the gateway actually routes are reachable — any other name
 * is a 404, so this is not an open proxy.
 */

import { Hono, type Context } from 'hono'
import type { HttpBindings } from '@hono/node-server'
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'node:crypto'
import { createRuntimeLogger } from '@operon/agent-runtime'
import type { PluginMcpServerExport } from '../services/operon-runtime/codex-plugin-apps.js'
import {
  gatewayCallTool,
  gatewayListTools,
  gatewayNeedsAuth,
  GatewayNeedsAuthError,
  pruneGatewayUpstreams,
  resetGatewayUpstream,
} from '../services/operon-runtime/mcp-gateway.js'
import { onMcpAuthChanged } from '../services/operon-runtime/mcp-oauth.js'
import { findGatewayServer, listPluginMcpMounts, pluginMcpMountName } from '../services/operon-runtime/plugin-mcp.js'
import { ensurePluginsLoaded } from '../services/operon-runtime/plugins.js'
import { readJsonBody, withCodexElicitationFallback } from './mcp-http.js'

const logger = createRuntimeLogger('mcp-gateway')

const CONNECT_REQUIRED_TOOL = 'connect_required'
/** A session no client has touched for this long is assumed abandoned (agent process gone). */
const SESSION_IDLE_MS = 24 * 60 * 60 * 1000

interface GatewaySession {
  /** Mount name (`plugin_<id>_<server>`) this session was opened on. */
  name: string
  server: Server
  transport: StreamableHTTPServerTransport
  lastSeen: number
}

const sessions = new Map<string, GatewaySession>()

// One subscription for the process: a sign-in change reaches every session on that server.
onMcpAuthChanged((runtimeName) => {
  void resetGatewayUpstream(runtimeName)
  notifyToolsChanged(pluginMcpMountName(runtimeName))
})

function notifyToolsChanged(name: string): void {
  for (const [id, session] of sessions) {
    if (session.name !== name) continue
    // Rides the client's standalone GET stream; a client without one simply never hears it.
    session.server.sendToolListChanged().catch((error: unknown) => {
      logger.warn(`tools/list_changed to ${id} failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}

function connectRequiredTool(server: PluginMcpServerExport): Tool {
  return {
    name: CONNECT_REQUIRED_TOOL,
    description:
      `${server.server} (${server.pluginName} plugin) needs you to sign in before its tools are available. ` +
      'Tell the user to open Operon → Plugins (sidebar) and click Connect.',
    inputSchema: { type: 'object', properties: {} },
  }
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/**
 * One MCP server per downstream session. The target is looked up on every request, not captured:
 * the session outlives sign-in changes, and the plugin may be disabled underneath it.
 */
function buildGatewayServer(name: string): Server {
  const server = new Server(
    { name: `operon-gateway-${name}`, version: '1.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const target = findGatewayServer(name)
    if (target === undefined) return { tools: [] }
    if (gatewayNeedsAuth(target)) return { tools: [connectRequiredTool(target)] }
    try {
      const tools = await gatewayListTools(target)
      return {
        tools: tools.map((tool) => ({
          ...tool,
          inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        })) as Tool[],
      }
    } catch (error) {
      if (error instanceof GatewayNeedsAuthError) return { tools: [connectRequiredTool(target)] }
      logger.error(`tools/list failed for ${target.runtimeName}: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const target = findGatewayServer(name)
    if (target === undefined) return errorResult(`${name} is no longer available — its plugin was disabled or removed.`)
    const { name: tool, arguments: args } = req.params
    if (tool === CONNECT_REQUIRED_TOOL || gatewayNeedsAuth(target)) {
      return errorResult(new GatewayNeedsAuthError(target).message)
    }
    try {
      return (await gatewayCallTool(target, tool, args ?? null, extra.signal)) as CallToolResult
    } catch (error) {
      if (error instanceof GatewayNeedsAuthError) return errorResult(error.message)
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`tools/call ${tool} failed for ${target.runtimeName}: ${message}`)
      return errorResult(`Error: ${message}`)
    }
  })

  return withCodexElicitationFallback(server)
}

async function openSession(name: string): Promise<StreamableHTTPServerTransport> {
  const server = buildGatewayServer(name)
  let session: GatewaySession | undefined
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    // Tool results stay plain JSON; list_changed rides the GET stream.
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      session = { name, server, transport, lastSeen: Date.now() }
      sessions.set(id, session)
    },
  })
  transport.onclose = () => {
    if (transport.sessionId !== undefined && sessions.get(transport.sessionId) === session) {
      sessions.delete(transport.sessionId)
    }
  }
  await server.connect(transport)
  return transport
}

function pruneIdleSessions(now: number): void {
  for (const [id, session] of sessions) {
    if (now - session.lastSeen < SESSION_IDLE_MS) continue
    sessions.delete(id)
    void session.transport.close().catch(() => {})
  }
}

export function mcpGatewayRoutes() {
  const router = new Hono()
  const handle = async (c: Context) => {
    await ensurePluginsLoaded()
    const name = c.req.param('name') ?? ''
    const { incoming, outgoing } = c.env as HttpBindings
    const now = Date.now()
    pruneIdleSessions(now)
    const routed = new Set(listPluginMcpMounts().filter((m) => m.kind === 'gateway').map((m) => m.runtimeName))
    void pruneGatewayUpstreams(routed)

    const sessionId = incoming.headers['mcp-session-id']
    if (typeof sessionId === 'string') {
      const session = sessions.get(sessionId)
      // 404 on an unknown session is the spec's "start over" signal: the client re-initializes.
      if (session === undefined || session.name !== name) return c.json({ error: 'Unknown MCP session' }, 404)
      session.lastSeen = now
      const body = incoming.method === 'POST' ? await readJsonBody(incoming) : undefined
      await session.transport.handleRequest(incoming, outgoing, body)
      return RESPONSE_ALREADY_SENT
    }

    if (findGatewayServer(name) === undefined) return c.json({ error: 'Unknown MCP gateway server' }, 404)
    const body = incoming.method === 'POST' ? await readJsonBody(incoming) : undefined
    if (!isInitializeRequest(body)) return c.json({ error: 'Expected an initialize request' }, 400)
    const transport = await openSession(name)
    await transport.handleRequest(incoming, outgoing, body)
    return RESPONSE_ALREADY_SENT
  }
  router.post('/:name', handle)
  router.get('/:name', handle)
  router.delete('/:name', handle)
  return router
}
