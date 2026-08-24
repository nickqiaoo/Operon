import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { NotificationStorageAdapter } from '../storage/interface.js'
import { emitInboxEvent, onInboxEvent } from '../services/channel-bus.js'
import { emitCounts } from '../services/notification-service.js'
import type { ListNotificationsQuery } from '../types/notification.js'

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

function positiveInteger(value: string | undefined): number | undefined {
  if (value == null) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * User notification inbox routes. Mounted at /api/inbox. Global (single-user
 * instance) — no project scoping, this aggregates across every project and
 * workspace.
 */
export function notificationRoutes(storage: NotificationStorageAdapter) {
  const router = new Hono()

  // ---- Live inbox stream (SSE) ----
  // Registered before any other GET so 'stream' is never mistaken for a path arg.
  router.get('/stream', (c) => {
    return streamSSE(c, async (stream) => {
      let closed = false
      stream.onAbort(() => {
        closed = true
      })
      // Send a counts snapshot on connect so a fresh client shows the right badge
      // without waiting for the next event.
      const counts = storage.notificationUnreadCounts()
      await stream
        .writeSSE({ data: JSON.stringify({ type: 'counts', ...counts }) })
        .catch(() => {})
      const unsub = onInboxEvent((event) => {
        if (closed) return
        stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {})
      })
      while (!closed) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1000))
      }
      unsub()
    })
  })

  // ---- List ----
  router.get('/', (c) => {
    const query: ListNotificationsQuery = {}
    const severity = c.req.query('severity')
    if (severity === 'action' || severity === 'info') query.severity = severity
    const unreadOnly = c.req.query('unreadOnly')
    if (unreadOnly === '1' || unreadOnly === 'true') query.unreadOnly = true
    const cursor = positiveInteger(c.req.query('cursor'))
    if (cursor != null) query.cursor = cursor

    const requestedLimit = positiveInteger(c.req.query('limit')) ?? DEFAULT_PAGE_SIZE
    const pageSize = Math.min(requestedLimit, MAX_PAGE_SIZE)
    const rows = storage.notificationList({ ...query, limit: pageSize + 1 })
    const hasMore = rows.length > pageSize
    const notifications = hasMore ? rows.slice(0, pageSize) : rows
    const nextCursor = hasMore ? notifications.at(-1)?.id : undefined

    return c.json({
      notifications,
      hasMore,
      ...(nextCursor != null ? { nextCursor } : {}),
    })
  })

  router.get('/counts', (c) => c.json(storage.notificationUnreadCounts()))

  // ---- Mutations ----
  router.post('/read', async (c) => {
    type ReadPayload = { ids?: number[]; sourceKeys?: string[]; all?: boolean }
    const body = await c.req
      .json<ReadPayload>()
      .catch(() => ({} as ReadPayload))
    const changed = storage.notificationMarkRead(body.all ? 'all' : (body.ids ?? []))
    if (!body.all) {
      const candidateSourceKeys = Array.isArray(body.sourceKeys) ? body.sourceKeys : []
      const sourceKeys = new Set(
        candidateSourceKeys.filter(
          (sourceKey): sourceKey is string =>
            typeof sourceKey === 'string' && sourceKey.trim().length > 0,
        ),
      )
      for (const sourceKey of sourceKeys) {
        changed.push(...storage.notificationMarkReadBySource(sourceKey))
      }
    }
    const changedIds = [...new Set(changed)]
    emitInboxEvent({ type: 'notification_read', ids: changedIds })
    emitCounts(storage)
    return c.json({ ids: changedIds })
  })

  router.post('/archive', async (c) => {
    const body = await c.req
      .json<{ ids?: number[]; all?: boolean }>()
      .catch(() => ({}) as { ids?: number[]; all?: boolean })
    const changed = storage.notificationArchive(body.all ? 'all' : (body.ids ?? []))
    emitInboxEvent({ type: 'notification_archive', ids: changed })
    emitCounts(storage)
    return c.json({ ids: changed })
  })

  return router
}
