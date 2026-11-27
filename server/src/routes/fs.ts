import { Hono } from 'hono'
import { open } from 'node:fs/promises'
import { Readable } from 'node:stream'
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

  router.post('/search-files', async (c) => {
    const { rootPath, query, limit } = await c.req.json<{ rootPath: string; query: string; limit?: number }>()
    const files = await fsService.searchFiles(rootPath, query, limit)
    return c.json({ files })
  })

  router.post('/read-file', async (c) => {
    const { path, preview } = await c.req.json<{ path: string; preview?: boolean }>()
    try {
      const content = preview ? await fsService.readPreviewText(path) : await fsService.readFile(path)
      if (content === null) return c.json({ error: 'Binary file' }, 415)
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
      const handle = await open(filePath, 'r')
      let ownsHandle = true
      try {
        const stat = await handle.stat()
        if (!stat.isFile()) return c.json({ error: 'Expected a regular file' }, 400)
        const headers = new Headers({
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
          'Content-Type': fsService.getFileMediaType(filePath),
          'X-Content-Type-Options': 'nosniff',
        })
        const range = c.req.header('Range')
        let start = 0
        let end = stat.size - 1
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range)
          if (match && (match[1] || match[2])) {
            start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]))
            if (match[1] && match[2]) end = Math.min(end, Number(match[2]))
          }
          if (!match || (!match[1] && !match[2]) || start > end) {
            headers.set('Content-Range', `bytes */${stat.size}`)
            return new Response(null, { status: 416, headers })
          }
          headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`)
        }
        headers.set('Content-Length', String(end - start + 1))
        if (!stat.size || c.req.method === 'HEAD') return new Response(null, { headers, status: range ? 206 : 200 })
        const stream = handle.createReadStream({ start, end })
        ownsHandle = false // the stream closes it on EOF or cancellation
        return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers, status: range ? 206 : 200 })
      } finally {
        if (ownsHandle) await handle.close()
      }
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
