/**
 * The personal assistant's own tools (services/assistant/tools.ts), served over MCP so that any
 * agent the user picks for the assistant — operon, Codex, Claude Code, OpenCode — calls the same
 * ones. Every URL the assistant hands out names the session (`role`, and the worker or wrap-up
 * `id`) and carries the process key; for OpenCode, which shares one client per directory, the
 * call itself names the session instead (see node-repl-bridge.ts).
 */
import type { HttpBindings } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  ASSISTANT_KEY_PARAM,
  isAssistantId,
  isAssistantMountKey,
  type AssistantCaller,
} from '../services/assistant/node-repl-bridge.js'
import { assistantToolHost, callAssistantTool, toolsFor, type AssistantToolHost } from '../services/assistant/tools.js'
import { readJsonBody, serveMcpOverHono } from './mcp-http.js'
import { resolveAssistantCaller, unknownCaller } from './mcp-caller.js'

/** The session a URL names; undefined when it names none properly. */
export function callerFromQuery(role: string | undefined, id: string | undefined): AssistantCaller | undefined {
  if (role === 'main') return { role: 'main' }
  if ((role === 'worker' || role === 'wrapup') && isAssistantId(id)) return { role, id }
  return undefined
}

function inputSchema(parameters: z.ZodObject<z.ZodRawShape>): Tool['inputSchema'] {
  const { $schema: _schema, ...schema } = z.toJSONSchema(parameters) as Record<string, unknown>
  return schema as Tool['inputSchema']
}

export function buildAssistantMcpServer(caller: AssistantCaller, host: AssistantToolHost): Server {
  const server = new Server({ name: 'assistant', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolsFor(caller.role).map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t.parameters) })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await callAssistantTool(request.params.name, request.params.arguments, caller, host)
    return { content: [{ type: 'text' as const, text: result.text }], ...(result.isError ? { isError: true } : {}) }
  })
  return server
}

export function assistantMcpRoutes() {
  const router = new Hono()
  const handle = async (c: Context) => {
    if (!isAssistantMountKey(c.req.query(ASSISTANT_KEY_PARAM))) return c.json({ error: 'forbidden' }, 403)
    const fromUrl = callerFromQuery(c.req.query('role'), c.req.query('id'))
    if (!fromUrl) return c.json({ error: 'role and id required' }, 400)
    const host = assistantToolHost()
    if (!host) return c.json({ error: 'the assistant is not running' }, 503)
    const { incoming } = c.env as HttpBindings
    let body: unknown
    let caller = fromUrl
    if (incoming.method === 'POST') {
      body = await readJsonBody(incoming)
      const resolved = resolveAssistantCaller(body, fromUrl)
      if (resolved.unknown) return unknownCaller(c, resolved.requestId).response
      caller = resolved.caller ?? fromUrl
    }
    return serveMcpOverHono(c, buildAssistantMcpServer(caller, host), body)
  }
  router.post('/', handle)
  router.get('/', handle)
  router.delete('/', handle)
  return router
}
