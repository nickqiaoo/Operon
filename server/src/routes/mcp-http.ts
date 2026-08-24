import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ErrorCode, isInitializeRequest, McpError } from '@modelcontextprotocol/sdk/types.js'
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response'
import type { HttpBindings } from '@hono/node-server'
import type { Context } from 'hono'
import { randomUUID } from 'node:crypto'

export interface StatefulMcpTransportHolder {
  transport?: StreamableHTTPServerTransport
  connecting?: Promise<StreamableHTTPServerTransport>
  transition?: Promise<void>
}

/**
 * Codex sends a proprietary `mcpServer/elicitation/request` to MCP servers; an
 * empty result tells it to fall back to native approvals (the hand-rolled
 * servers answered it with `{}`). The official `Server` returns MethodNotFound
 * for unknown methods, so wire a fallback that preserves the `{}` reply and
 * leaves every other unknown method as a genuine MethodNotFound.
 */
export function withCodexElicitationFallback(server: Server): Server {
  server.fallbackRequestHandler = async (request) => {
    if (request.method === 'mcpServer/elicitation/request') return {}
    throw new McpError(ErrorCode.MethodNotFound, `Method not found: ${request.method}`)
  }
  return server
}

/**
 * Stateful variant: keeps one long-lived transport for the current client so
 * the server can send **requests to it** (MCP `elicitation/create`). A fresh
 * client can replace that transport without replacing the server or its state.
 *
 * Why a second function instead of a flag on `serveMcpOverHono`: the stateless
 * one is used by five other routes (workspace_chat / taskboard / memory /
 * external_agent / im_chat). They are pure request/response and were made
 * stateless deliberately; there is no reason to put them at risk.
 *
 * ## Why node_repl needs this
 * Browser Use asks for consent before every cross-origin navigation
 * (`nodeRepl.createElicitation` → MCP `elicitation/create`). That is a
 * **server→client request**, which the stateless bridge cannot carry: it builds a
 * fresh transport per request and closes the server when the response ends, so
 * there is no channel to ask on. Consent would silently auto-accept forever.
 *
 * Codex does not have this problem because its node_repl is a **stdio** MCP server
 * (`~/.codex/config.toml`: `[mcp_servers.node_repl] command = ".../bin/node_repl"`),
 * and stdio is inherently a persistent bidirectional pipe. operon mounts MCP over
 * HTTP because the same servers are consumed by several external agent CLIs — so we
 * have to earn the back-channel that stdio gives away for free.
 *
 * ## How the back-channel actually works
 * Server→client **requests** carry no `relatedRequestId`, so the SDK routes them to
 * the client's standalone `GET` SSE stream (`_standaloneSseStreamId = "_GET_stream"`),
 * *not* to the POST response. That is why `enableJsonResponse: true` can stay:
 * tool results remain plain JSON, and only elicitation rides the GET stream.
 * A client that never opens a GET stream simply makes `server.request` fail →
 * `requestElicitation` falls back to accept (see adapters/mcp.ts).
 */
export async function serveMcpStatefulOverHono(
  c: Context,
  server: Server,
  holder: StatefulMcpTransportHolder,
): Promise<Response> {
  const { incoming, outgoing } = c.env as HttpBindings
  const parsedBody = incoming.method === 'POST'
    ? await readJsonBody(incoming)
    : undefined
  const startsNewClient =
    incoming.headers['mcp-session-id'] === undefined &&
    isInitializeRequest(parsedBody)
  const transport = await selectStatefulTransport(server, holder, startsNewClient)
  await transport.handleRequest(incoming, outgoing, parsedBody)
  return RESPONSE_ALREADY_SENT
}

async function readJsonBody(incoming: HttpBindings['incoming']): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of incoming) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(raw) as unknown
  } catch {
    // Passing the unparsed value lets the SDK return its normal JSON-RPC parse error.
    return raw
  }
}

async function selectStatefulTransport(
  server: Server,
  holder: StatefulMcpTransportHolder,
  startsNewClient: boolean,
): Promise<StreamableHTTPServerTransport> {
  let selected: StreamableHTTPServerTransport | undefined
  const previousTransition = holder.transition ?? Promise.resolve()
  const transition = previousTransition
    .catch(() => {})
    .then(async () => {
      // A fresh initialize without an MCP session id belongs to a new client.
      // Keep the Server (and therefore node_repl's kernel-backed handlers), but
      // detach the previous client's transport before accepting the replacement.
      if (startsNewClient && holder.transport?.sessionId) {
        const previous = holder.transport
        holder.transport = undefined
        holder.connecting = undefined
        await previous.close()
      }

      selected = holder.transport ?? await connectStatefulTransport(server, holder)
    })
  holder.transition = transition
  await transition
  if (!selected) throw new Error('Failed to establish MCP transport')
  return selected
}

async function connectStatefulTransport(
  server: Server,
  holder: StatefulMcpTransportHolder,
): Promise<StreamableHTTPServerTransport> {
  if (holder.transport) return holder.transport
  if (holder.connecting) return holder.connecting

  const connecting = (async () => {
    const transport = new StreamableHTTPServerTransport({
      // Stateful: the transport mints an `mcp-session-id` on initialize and binds
      // the GET stream to it. This is the whole point — without a session there is
      // nothing for the standalone stream to attach to.
      sessionIdGenerator: () => randomUUID(),
      // Tool results stay plain JSON (see above: elicitation rides the GET stream).
      enableJsonResponse: true,
    })
    transport.onclose = () => {
      if (holder.transport === transport) holder.transport = undefined
    }
    // ⚠️ Do NOT close the server when a response ends — the transport must outlive
    // individual requests. Lifecycle belongs to whoever owns `holder`.
    await server.connect(transport)
    holder.transport = transport
    return transport
  })()
  holder.connecting = connecting
  try {
    return await connecting
  } finally {
    if (holder.connecting === connecting) holder.connecting = undefined
  }
}

/**
 * Bridge an MCP `Server` onto a Hono request using the official Streamable HTTP
 * transport, in **stateless** mode (identity travels in the URL query, so there
 * is no session to maintain across requests).
 *
 * Why this exists: we previously hand-rolled the JSON-RPC plumbing. The JS MCP
 * clients tolerated it, but Codex's Rust `rmcp` Streamable-HTTP client does
 * strict content negotiation and rejected empty/malformed responses during the
 * `initialize` handshake ("missing-content-type"), so every local HTTP MCP
 * server (workspace_chat / taskboard / memory / external_agent) failed to
 * start for Codex.
 * Delegating to the official transport keeps the handshake spec-correct while
 * direct JSON mode avoids unnecessary SSE framing for these request/response
 * tools.
 *
 * Requires the server to run under `@hono/node-server` (we read the raw Node
 * `req`/`res` off `c.env`). Returns the node-server sentinel so Hono knows the
 * response was already written by the transport.
 */
export async function serveMcpOverHono(c: Context, server: Server): Promise<Response> {
  const { incoming, outgoing } = c.env as HttpBindings
  // Stateless: a fresh transport per request, no session id.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  outgoing.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  // The transport reads the body straight off the Node stream — we must NOT have
  // consumed it via c.req.json()/text() beforehand (only query/headers are read).
  await transport.handleRequest(incoming, outgoing)
  return RESPONSE_ALREADY_SENT
}
