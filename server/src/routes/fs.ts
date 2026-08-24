import { Hono } from 'hono'
import type { Context } from 'hono'
import * as fsService from '../services/fs.js'

/**
 * Maps a filesystem read error to a clean client response. Model-written file
 * citations frequently point at a folder or a path that doesn't resolve to a
 * real file (bare/relative names in monorepos); without this those surface as a
 * raw 500 "EISDIR/ENOENT" in the preview pane. Returns a friendly message the
 * pane can show as-is.
 */
function fileReadErrorResponse(c: Context, err: unknown, filePath: string) {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return c.json({ error: `File not found: ${filePath}` }, 404)
  if (code === 'EISDIR') return c.json({ error: 'This is a folder, not a file' }, 400)
  console.error('[fs] failed to read file:', filePath, err)
  return c.json({ error: err instanceof Error ? err.message : 'Failed to read file' }, 500)
}

export function fsRoutes() {
  const router = new Hono()

  router.post('/read-dir', async (c) => {
    const { path } = await c.req.json<{ path: string }>()
    const result = await fsService.readDir(path)
    return c.json(result)
  })

  router.post('/find-paths', async (c) => {
    const { rootPath, query, limit } = await c.req.json<{
      rootPath: string
      query: string
      limit?: number
    }>()
    const result = await fsService.findPaths(rootPath, query, limit)
    return c.json(result)
  })

  router.post('/read-file', async (c) => {
    const { path } = await c.req.json<{ path: string }>()
    try {
      const content = await fsService.readFile(path)
      return c.json({ content })
    } catch (err) {
      return fileReadErrorResponse(c, err, path)
    }
  })

  router.get('/file', async (c) => {
    const filePath = c.req.query('path')
    if (!filePath) {
      return c.json({ error: 'path is required' }, 400)
    }

    try {
      const { buffer, mediaType } = await fsService.readFileAsset(filePath)
      const body = new Blob([Uint8Array.from(buffer)], { type: mediaType })
      return new Response(body, {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': mediaType,
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (err) {
      return fileReadErrorResponse(c, err, filePath)
    }
  })

  router.post('/write-file', async (c) => {
    const { path, content } = await c.req.json<{ path: string; content: string }>()
    await fsService.writeFile(path, content)
    return c.json({ success: true })
  })

  router.post('/save-temp-file', async (c) => {
    const { content, extension } = await c.req.json<{ content: string; extension?: string }>()
    const filePath = await fsService.saveTempFile(content, extension)
    return c.json({ path: filePath })
  })

  router.post('/exists', async (c) => {
    const { path } = await c.req.json<{ path: string }>()
    const result = await fsService.exists(path)
    return c.json({ exists: result })
  })

  router.get('/home-path', (c) => {
    return c.json({ path: fsService.getHomePath() })
  })

  router.post('/stat', async (c) => {
    const { path } = await c.req.json<{ path: string }>()
    const result = await fsService.stat(path)
    return c.json(result)
  })

  return router
}
