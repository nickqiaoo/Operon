import { Hono } from 'hono'
import { getMcpServers, saveMcpServers, type McpServersConfig } from '../services/mcp-config.js'
import { listPluginMcpMounts } from '../services/operon-runtime/plugin-mcp.js'
import { ensurePluginsLoaded } from '../services/operon-runtime/plugins.js'

export function mcpRoutes() {
  const router = new Hono()

  // GET /api/mcp/servers
  router.get('/servers', (c) => {
    const servers = getMcpServers()
    return c.json({ servers })
  })

  // GET /api/mcp/plugin-servers — read-only: what enabled plugins contribute to every agent.
  // Managed from the Plugins page; listed here so the MCP page shows the full picture.
  router.get('/plugin-servers', async (c) => {
    await ensurePluginsLoaded()
    const userNames = new Set(Object.keys(getMcpServers()))
    const servers = listPluginMcpMounts().map((m) => ({
      name: m.name,
      pluginId: m.pluginId,
      pluginName: m.pluginName,
      server: m.server,
      transport: m.transport,
      mode: m.kind,
      ...(m.kind === 'skip' ? { reason: m.reason } : {}),
      ...(m.kind === 'gateway' ? { gatewayReason: m.reason } : {}),
      // A same-named server in Settings → MCP wins; the plugin's is not mounted.
      shadowed: userNames.has(m.name),
    }))
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
