import { Hono } from 'hono'
import { getMcpServers, saveMcpServers, type McpServersConfig } from '../services/mcp-config.js'

export function mcpRoutes() {
  const router = new Hono()

  // GET /api/mcp/servers
  router.get('/servers', (c) => {
    const servers = getMcpServers()
    return c.json({ servers })
  })

  // PUT /api/mcp/servers
  router.put('/servers', async (c) => {
    const { servers } = await c.req.json<{ servers: McpServersConfig }>()
    saveMcpServers(servers)
    return c.json({ servers })
  })

  return router
}
