/**
 * Memory MCP Server.
 *
 * Exposes the memory agent tools (memory_search + memory_upsert) as a
 * standalone MCP server the agent runtime connects to via mcp-config.ts. Tool
 * names, descriptions, and JSON schemas come from services/memory/operations.ts
 * so this file + memory-tools.ts + the REST route stay aligned. Transport is the
 * official MCP SDK Streamable HTTP
 * (see ./mcp-http.ts) — strict clients (Codex's rmcp) require its SSE framing.
 *
 * Mounted at /api/memory-mcp in app.ts. Auto-injected into
 * buildMcpServersForCli when MemoryService is initialized.
 */

import { Hono, type Context } from 'hono'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { MemoryService } from '../services/memory/index.js'
import {
  MEMORY_MCP_TOOLS,
  dispatchMemoryTool,
  type MemoryToolContext,
} from '../services/memory/operations.js'
import { createRuntimeLogger } from '@operon/agent-runtime'
import {
  MAINTENANCE_ORIGIN,
  getExtractionSource,
} from '../services/memory-maintenance/extraction-source.js'
import { serveMcpOverHono, withCodexElicitationFallback } from './mcp-http.js'

const logger = createRuntimeLogger('memory-mcp')

function buildMemoryMcpServer(ctx: MemoryToolContext): Server {
  const server = new Server(
    { name: 'memory', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MEMORY_MCP_TOOLS as Tool[],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params

    let engine
    try {
      engine = MemoryService.getInstance().getEngine()
    } catch {
      return { content: [{ type: 'text', text: 'Memory service not available.' }] }
    }

    if (!MEMORY_MCP_TOOLS.find((t) => t.name === name)) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
    }

    try {
      const text = await dispatchMemoryTool(engine, name, args ?? {}, ctx)
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      const stack = err instanceof Error ? err.stack ?? err.message : String(err)
      logger.error(`tools/call error for ${name}: ${stack}`)
      return { content: [{ type: 'text', text: `Error: ${stack}` }], isError: true }
    }
  })

  return withCodexElicitationFallback(server)
}

/**
 * Writes over a connection marked `?origin=maintenance` come from the background
 * extractor; record the conversation it is reading. Live sessions carry no
 * marker and get no source.
 */
function readContext(c: Context): MemoryToolContext {
  if (c.req.query('origin') !== MAINTENANCE_ORIGIN) return {}
  const source = getExtractionSource()
  return source ? { source } : {}
}

// ---- Hono router ----

export function memoryMcpRoutes() {
  const router = new Hono()
  const handle = (c: Context) => serveMcpOverHono(c, buildMemoryMcpServer(readContext(c)))
  router.post('/', handle)
  router.get('/', handle)
  router.delete('/', handle)
  return router
}
