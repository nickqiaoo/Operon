import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import * as gitRepoWatcher from '../services/git-repo-watcher.js'

/**
 * Bridges the server-side git-repo-watcher to the browser over SSE. Codex ships
 * these events over an in-process bus; we serialize them onto an event stream.
 *
 *   POST /api/git/watch    { root }  -> start/ref-count a watcher
 *   POST /api/git/unwatch  { root }  -> release one reference
 *   GET  /api/git/watch-events       -> SSE stream of git-repo-changed events
 */
export function gitWatchRoutes() {
  const router = new Hono()

  router.post('/watch', async (c) => {
    const { root } = await c.req.json<{ root: string }>()
    if (!root) return c.json({ ok: false, error: 'root required' }, 400)
    try {
      await gitRepoWatcher.watchRepo(root)
      return c.json({ ok: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return c.json({ ok: false, error: message }, 500)
    }
  })

  router.post('/unwatch', async (c) => {
    const { root } = await c.req.json<{ root: string }>()
    if (!root) return c.json({ ok: false, error: 'root required' }, 400)
    gitRepoWatcher.unwatchRepo(root)
    return c.json({ ok: true })
  })

  router.get('/watch-events', (c) => {
    return streamSSE(c, async (stream) => {
      let closed = false
      stream.onAbort(() => {
        closed = true
      })

      const unsubscribe = gitRepoWatcher.addEventListener((event) => {
        if (closed) return
        stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {})
      })

      while (!closed) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }

      unsubscribe()
    })
  })

  return router
}
