/**
 * Memory REST route — thin wrapper around MemoryService for the settings
 * panel and external HTTP callers. All operations go through the shared
 * MemoryEngine singleton so the panel, the MCP route, and the AI-SDK
 * tool surface see the same data.
 *
 * The four tools are defined in the memory service.
 */

import { Hono } from 'hono'
import { MemoryService, memorySearch } from '../services/memory/index.js'
import { MEMORY_TYPES, type MemoryType } from '../services/memory/types.js'

function getEngine() {
  try {
    return MemoryService.getInstance().getEngine()
  } catch {
    return null
  }
}

function parseType(value: string | undefined): MemoryType | undefined {
  if (!value) return undefined
  if (!(MEMORY_TYPES as string[]).includes(value)) return undefined
  return value as MemoryType
}

export function memoryRoutes() {
  const router = new Hono()

  // list pages (admin / settings panel)
  router.get('/pages', (c) => {
    const engine = getEngine()
    if (!engine) return c.json({ error: 'Memory service not available' }, 503)
    const type = parseType(c.req.query('type'))
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined
    const pages = engine.listPages({ type, limit })
    return c.json(pages)
  })

  // delete a page (admin / settings panel)
  router.delete('/pages/:type/:slug', async (c) => {
    const engine = getEngine()
    if (!engine) return c.json({ error: 'Memory service not available' }, 503)
    const type = parseType(c.req.param('type'))
    if (!type) return c.json({ error: `type must be one of: ${MEMORY_TYPES.join(', ')}` }, 400)
    const slug = c.req.param('slug')
    const ok = await engine.deletePage(type, slug)
    if (!ok) return c.json({ error: 'Not found' }, 404)
    return c.json({ success: true })
  })

  // memory_search
  router.post('/search', async (c) => {
    const engine = getEngine()
    if (!engine) return c.json({ error: 'Memory service not available' }, 503)
    const body = await c.req.json<{
      query: string
      types?: string[]
      type?: string
      limit?: number
    }>()
    if (!body.query?.trim()) return c.json({ error: 'query is required' }, 400)

    const rawTypes = body.types ?? (body.type ? [body.type] : undefined)
    const types = rawTypes
      ?.map((t) => parseType(t))
      .filter((t): t is MemoryType => t !== undefined)

    const results = await memorySearch(engine, body.query, {
      types,
      limit: body.limit,
    })
    return c.json(results)
  })

  // memory_get
  router.get('/pages/:type/:slug', (c) => {
    const engine = getEngine()
    if (!engine) return c.json({ error: 'Memory service not available' }, 503)
    const type = parseType(c.req.param('type'))
    if (!type) return c.json({ error: `type must be one of: ${MEMORY_TYPES.join(', ')}` }, 400)
    const slug = c.req.param('slug')
    const page = engine.getPage(type, slug)
    if (!page) return c.json({ error: 'Not found' }, 404)
    const timeline = engine.getTimelineRecent(type, slug, 10)
    return c.json({ ...page, timeline })
  })

  // memory_timeline (paginated)
  router.get('/pages/:type/:slug/timeline', (c) => {
    const engine = getEngine()
    if (!engine) return c.json({ error: 'Memory service not available' }, 503)
    const type = parseType(c.req.param('type'))
    if (!type) return c.json({ error: `type must be one of: ${MEMORY_TYPES.join(', ')}` }, 400)
    const slug = c.req.param('slug')
    const since = c.req.query('since') ? Number(c.req.query('since')) : undefined
    const until = c.req.query('until') ? Number(c.req.query('until')) : undefined
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined
    const cursor = c.req.query('cursor') ? Number(c.req.query('cursor')) : undefined
    const entries = engine.pageTimeline(type, slug, { since, until, limit, cursor })
    // Cursor is the effective time (occurred_at, or created_at when unknown) to
    // match pageTimeline's COALESCE ordering — a NULL occurred_at must not stall paging.
    const last = entries[entries.length - 1]
    const nextCursor = last ? (last.occurred_at ?? last.created_at) : null
    return c.json({ entries, next_cursor: nextCursor })
  })

  // memory_upsert
  router.put('/pages/:type/:slug', async (c) => {
    const engine = getEngine()
    if (!engine) return c.json({ error: 'Memory service not available' }, 503)
    const type = parseType(c.req.param('type'))
    if (!type) return c.json({ error: `type must be one of: ${MEMORY_TYPES.join(', ')}` }, 400)
    const slugHint = c.req.param('slug')

    const body = await c.req.json<{
      truth: string
      timeline_entry: { entry: string; occurred_at?: number }
    }>()
    if (!body.truth?.trim()) return c.json({ error: 'truth is required' }, 400)
    if (!body.timeline_entry?.entry?.trim()) {
      return c.json({ error: 'timeline_entry.entry is required' }, 400)
    }

    try {
      const result = await engine.upsert(type, slugHint, body.truth, {
        entry: body.timeline_entry.entry,
        occurred_at: body.timeline_entry.occurred_at,
      })
      return c.json(result)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  return router
}
