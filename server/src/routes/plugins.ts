import { Hono, type Context } from 'hono'
import * as plugins from '../services/operon-runtime/plugins.js'

/**
 * Plugin management API — session-independent. The operon plugin store is global (single home dir),
 * so these endpoints drive the shared global PluginManager directly without any chat/session. The
 * Settings "Custom" tab calls these; the chat Activity panel uses GET /list for a read-only view.
 */
export function pluginRoutes() {
  const router = new Hono()

  const fail = (c: Context, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ error: message }, 500)
  }

  router.get('/list', async (c) => {
    try {
      return c.json({ plugins: await plugins.listPlugins() })
    } catch (error) {
      return fail(c, error)
    }
  })

  router.get('/info', async (c) => {
    try {
      const id = c.req.query('id')
      if (!id) return c.json({ error: 'id is required' }, 400)
      const info = await plugins.getPluginInfo(id)
      if (info === null) return c.json({ error: 'not found' }, 404)
      return c.json({ info })
    } catch (error) {
      return fail(c, error)
    }
  })

  // ── MCP OAuth (per plugin server) ──────────────────────────────────────────
  router.get('/mcp-auth/status', async (c) => {
    try {
      const id = c.req.query('id')
      if (!id) return c.json({ error: 'id is required' }, 400)
      return c.json({ servers: await plugins.getMcpAuthStatus(id) })
    } catch (error) {
      return fail(c, error)
    }
  })

  router.post('/mcp-auth/begin', async (c) => {
    try {
      const { id, server } = await c.req.json<{ id?: string; server?: string }>()
      if (!id || !server) return c.json({ error: 'id and server are required' }, 400)
      return c.json(await plugins.startMcpAuth(id, server))
    } catch (error) {
      return fail(c, error)
    }
  })

  router.post('/mcp-auth/cancel', async (c) => {
    try {
      const { id, server } = await c.req.json<{ id?: string; server?: string }>()
      if (!id || !server) return c.json({ error: 'id and server are required' }, 400)
      await plugins.cancelPluginMcpAuth(id, server)
      return c.json({ ok: true })
    } catch (error) {
      return fail(c, error)
    }
  })

  router.post('/mcp-auth/disconnect', async (c) => {
    try {
      const { id, server } = await c.req.json<{ id?: string; server?: string }>()
      if (!id || !server) return c.json({ error: 'id and server are required' }, 400)
      await plugins.disconnectPluginMcp(id, server)
      return c.json({ ok: true })
    } catch (error) {
      return fail(c, error)
    }
  })

  router.get('/mcp-tools', async (c) => {
    try {
      const id = c.req.query('id')
      const server = c.req.query('server')
      if (!id || !server) return c.json({ error: 'id and server are required' }, 400)
      return c.json({ tools: await plugins.getMcpServerTools(id, server) })
    } catch (error) {
      return fail(c, error)
    }
  })

  router.get('/skill', async (c) => {
    try {
      const id = c.req.query('id')
      const skill = c.req.query('skill')
      if (!id || !skill) return c.json({ error: 'id and skill are required' }, 400)
      const content = await plugins.getSkillContent(id, skill)
      if (content === null) return c.json({ error: 'not found' }, 404)
      return c.json({ content })
    } catch (error) {
      return fail(c, error)
    }
  })

  router.post('/install', async (c) => {
    try {
      const { source } = await c.req.json<{ source?: string }>()
      if (!source) return c.json({ error: 'source is required' }, 400)
      return c.json({ plugin: await plugins.installPlugin(source) })
    } catch (error) {
      return fail(c, error)
    }
  })

  router.post('/set-enabled', async (c) => {
    try {
      const { id, enabled } = await c.req.json<{ id?: string; enabled?: boolean }>()
      if (!id) return c.json({ error: 'id is required' }, 400)
      await plugins.setPluginEnabled(id, enabled === true)
      return c.json({ ok: true })
    } catch (error) {
      return fail(c, error)
    }
  })

  router.post('/set-mcp-enabled', async (c) => {
    try {
      const { id, server, enabled } = await c.req.json<{ id?: string; server?: string; enabled?: boolean }>()
      if (!id || !server) return c.json({ error: 'id and server are required' }, 400)
      await plugins.setPluginMcpEnabled(id, server, enabled === true)
      return c.json({ ok: true })
    } catch (error) {
      return fail(c, error)
    }
  })

  router.post('/remove', async (c) => {
    try {
      const { id } = await c.req.json<{ id?: string }>()
      if (!id) return c.json({ error: 'id is required' }, 400)
      await plugins.removePlugin(id)
      return c.json({ ok: true })
    } catch (error) {
      return fail(c, error)
    }
  })

  router.post('/reload', async (c) => {
    try {
      await plugins.reloadPlugins()
      return c.json({ ok: true })
    } catch (error) {
      return fail(c, error)
    }
  })

  router.post('/marketplace', async (c) => {
    try {
      const body = await c.req.json<{ source?: string }>().catch(() => ({}) as { source?: string })
      return c.json(await plugins.browseMarketplaces(body.source))
    } catch (error) {
      return fail(c, error)
    }
  })

  // Lazy per-entry detail enrichment (logo / description) for the marketplace browse view.
  router.post('/marketplace/details', async (c) => {
    try {
      const body = await c.req.json<{ sources?: string[] }>().catch(() => ({}) as { sources?: string[] })
      if (!Array.isArray(body.sources)) return c.json({ error: 'sources[] is required' }, 400)
      return c.json({ details: await plugins.getMarketplaceEntryDetails(body.sources) })
    } catch (error) {
      return fail(c, error)
    }
  })

  // Full detail (example prompts / MCP servers / skills / developer) for a not-yet-installed entry,
  // read from the cached repo. `info` is null for non-local entries (nothing readable locally).
  router.post('/marketplace/info', async (c) => {
    try {
      const { source } = await c.req.json<{ source?: string }>().catch(() => ({}) as { source?: string })
      if (!source) return c.json({ error: 'source is required' }, 400)
      return c.json({ info: await plugins.getMarketplaceEntryInfo(source) })
    } catch (error) {
      return fail(c, error)
    }
  })

  // A not-yet-installed entry's skill SKILL.md, read from the cached repo.
  router.get('/marketplace/skill', async (c) => {
    try {
      const source = c.req.query('source')
      const skill = c.req.query('skill')
      if (!source || !skill) return c.json({ error: 'source and skill are required' }, 400)
      const content = await plugins.getMarketplaceSkillContent(source, skill)
      if (content === null) return c.json({ error: 'not found' }, 404)
      return c.json({ content })
    } catch (error) {
      return fail(c, error)
    }
  })

  // Serve a plugin logo image from the marketplace cache (referenced by detail `logoAsset` paths).
  router.get('/asset', async (c) => {
    const path = c.req.query('path')
    if (!path) return c.json({ error: 'path is required' }, 400)
    const asset = await plugins.getMarketplaceAsset(path)
    if (asset === null) return c.json({ error: 'not found' }, 404)
    return new Response(new Uint8Array(asset.data), {
      status: 200,
      headers: { 'Content-Type': asset.contentType, 'Cache-Control': 'public, max-age=86400' },
    })
  })

  return router
}
