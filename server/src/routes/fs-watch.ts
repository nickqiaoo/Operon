import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import * as fsWatchService from '../services/fs-watch.js'

export function fsWatchRoutes() {
  const router = new Hono()

  // POST /api/fs/watch - create a watch
  router.post('/watch', async (c) => {
    const { path, options } = await c.req.json<{
      path: string
      options?: { ignored?: string | string[]; depth?: number }
    }>()
    const id = fsWatchService.createWatch(path, options)
    return c.json({ id })
  })

  // POST /api/fs/unwatch - remove a watch
  router.post('/unwatch', async (c) => {
    const { id } = await c.req.json<{ id: string }>()
    const success = fsWatchService.removeWatch(id)
    return c.json({ success })
  })

  // GET /api/fs/watch-events - SSE stream
  router.get('/watch-events', (c) => {
    return streamSSE(c, async (stream) => {
      let closed = false

      stream.onAbort(() => {
        closed = true
      })

      const unsubscribe = fsWatchService.addEventListener((event) => {
        if (closed) return
        stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {})
      })

      // Keep alive
      while (!closed) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }

      unsubscribe()
    })
  })

  return router
}
