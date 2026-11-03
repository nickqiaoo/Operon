import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

/**
 * Opens one channel's existing SSE feed. Given the outer request's query so a
 * channel can read its own parameters (e.g. the workflow feed's `limit`).
 */
export type EventChannelSource = (query: URLSearchParams) => Response | Promise<Response>

/**
 * GET /api/events?ch=inbox,tasks,… — the app's always-open feeds on ONE stream.
 *
 * The renderer reaches this server over plain HTTP/1.1, where Chromium allows six
 * connections per host and never multiplexes. Five feeds held open for the whole
 * session plus a chat's own stream used all six, so any request made while a turn
 * was running — a permission answer, a steer — queued behind connections that
 * never close. Electron lifts the limit with a command-line switch; a plain
 * browser (Playwright, standalone dev) cannot.
 *
 * Each channel is still served by its own route: this opens them in process via
 * the sub-router (skipping the app-level middleware, which already ran once for
 * this request — the E2EE layer in particular must not wrap twice) and re-frames
 * every `data:` line as `{"ch":<name>,"data":<payload>}`. The payload is spliced
 * in as-is; it is already JSON.
 *
 * If any channel's stream ends, the whole response ends. Every channel opens with
 * a full snapshot, so the client reconnecting all of them together is correct,
 * where a half-alive stream would silently go stale.
 */
export function eventRoutes(channels: Record<string, EventChannelSource>) {
  const router = new Hono()

  router.get('/', async (c) => {
    const query = new URL(c.req.url).searchParams
    const requested = [...new Set((query.get('ch') ?? '').split(',').map((name) => name.trim()).filter(Boolean))]
    const unknown = requested.filter((name) => !(name in channels))
    if (requested.length === 0 || unknown.length > 0) {
      return c.json({ error: `Unknown or missing channels: ${unknown.join(', ') || '(none)'}` }, 400)
    }

    return streamSSE(c, async (stream) => {
      const readers: ReadableStreamDefaultReader<Uint8Array>[] = []
      let finish!: () => void
      const finished = new Promise<void>((resolve) => { finish = resolve })
      stream.onAbort(finish)

      const pump = async (name: string, body: ReadableStream<Uint8Array>) => {
        const reader = body.getReader()
        readers.push(reader)
        const decoder = new TextDecoder()
        const prefix = `data: {"ch":${JSON.stringify(name)},"data":`
        let buffer = ''
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              if (!line.startsWith('data:')) continue
              const payload = line.slice(5).trim()
              if (payload) await stream.write(`${prefix}${payload}}\n\n`)
            }
          }
        } catch {
          // Cancelled on teardown, or the channel failed: either way it is over.
        }
        finish()
      }

      try {
        for (const name of requested) {
          const response = await channels[name](query)
          if (!response.ok || response.body == null) throw new Error(`channel ${name} failed: ${response.status}`)
          void pump(name, response.body)
        }
        await finished
      } finally {
        // Cancelling a channel's body is what runs its own cleanup (unsubscribe).
        await Promise.allSettled(readers.map((reader) => reader.cancel()))
      }
    })
  })

  return router
}
