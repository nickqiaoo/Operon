import { Hono } from 'hono'
import type {
  AgentBindingStorageAdapter,
  ChannelStorageAdapter,
  NotificationStorageAdapter,
  ProjectStorageAdapter,
  TaskStorageAdapter,
} from '../../storage/interface.js'
import { REMOTE_TUNNEL_HEADER } from '@shared/e2ee/protocol'
import { handleLinearEvent, type InboundMeta } from './inbound-linear.js'
import { handleGithubEvent } from './inbound-github.js'

// POST /api/integrations/events/{linear,github} — webhook events the broker
// verified and routed to this node (docs/linear-github/design.md §6, §8).
//
// Trust: only frames that came down the tunnel with the broker's own marker
// header are accepted. The broker strips `x-operon-origin` off client
// traffic, and the tunnel agent stamps `x-operon-remote-tunnel`, so a browser
// or a local process cannot forge an event. The reply is immediate — the
// broker never waits on it — and the work runs in the background.

type Storage = TaskStorageAdapter & ChannelStorageAdapter & ProjectStorageAdapter & NotificationStorageAdapter & AgentBindingStorageAdapter

let appSlugHint: string | undefined

export function setGithubAppSlugHint(slug: string | undefined): void {
  appSlugHint = slug || undefined
}

export function surfaceEventsRoutes(storage: Storage) {
  const router = new Hono()

  router.use('*', async (c, next) => {
    const origin = c.req.header('x-operon-origin')
    const viaTunnel = c.req.header(REMOTE_TUNNEL_HEADER) === '1'
    if (origin !== 'webhook' || !viaTunnel) {
      return c.json({ error: 'forbidden' }, 403)
    }
    await next()
  })

  const metaOf = (c: { req: { header(name: string): string | undefined } }): InboundMeta => ({
    event: c.req.header('x-operon-webhook-event') ?? '',
    delivery: c.req.header('x-operon-webhook-delivery') ?? '',
    routeReason: c.req.header('x-operon-route-reason') ?? '',
    actor: c.req.header('x-operon-actor') ?? 'unknown',
  })

  router.post('/linear', async (c) => {
    const meta = metaOf(c)
    if (meta.delivery && !storage.surfaceDeliveryMark(`linear:${meta.delivery}`)) {
      return c.json({ ok: true, duplicate: true })
    }
    const payload = await c.req.json().catch(() => null)
    if (!payload) return c.json({ error: 'bad json' }, 400)
    console.log('[Surfaces] linear', describeLinear(meta, payload))
    void handleLinearEvent(storage, meta, payload).catch((err) => {
      console.error('[Surfaces] linear event failed:', err)
    })
    return c.json({ ok: true })
  })

  router.post('/github', async (c) => {
    const meta = metaOf(c)
    if (meta.delivery && !storage.surfaceDeliveryMark(`github:${meta.delivery}`)) {
      return c.json({ ok: true, duplicate: true })
    }
    const payload = await c.req.json().catch(() => null)
    if (!payload) return c.json({ error: 'bad json' }, 400)
    console.log('[Surfaces] github', `${meta.event}/${str((payload as Record<string, unknown>).action)} delivery=${meta.delivery} route=${meta.routeReason} actor=${meta.actor}`)
    void handleGithubEvent(storage, meta, payload, appSlugHint).catch((err) => {
      console.error('[Surfaces] github event failed:', err)
    })
    return c.json({ ok: true })
  })

  return router
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

// One line per delivery with the fields the handlers key on. Linear does not
// publish payload examples for agent sessions, so this is also how the field
// names get verified against real traffic (docs/linear-github/status.md §4).
function describeLinear(meta: InboundMeta, payload: unknown): string {
  const p = obj(payload)
  let detail: Record<string, unknown>
  if (meta.event === 'AgentSessionEvent') {
    const session = obj(p.agentSession)
    const activity = p.agentActivity ? obj(p.agentActivity) : null
    detail = {
      session: session.id,
      status: session.status,
      type: session.type,
      creatorId: session.creatorId,
      commentId: session.commentId,
      sourceCommentId: session.sourceCommentId,
      issue: obj(session.issue).identifier,
      activity: activity
        ? { id: activity.id, userId: activity.userId, sourceCommentId: activity.sourceCommentId, signal: activity.signal, content: activity.content }
        : undefined,
    }
  } else {
    const data = obj(p.data)
    detail = {
      id: data.id,
      issueId: data.issueId,
      parentId: data.parentId,
      userId: data.userId,
      botActor: data.botActor,
      updatedFrom: p.updatedFrom ? Object.keys(obj(p.updatedFrom)) : undefined,
    }
  }
  return `${meta.event}/${str(p.action)} delivery=${meta.delivery} route=${meta.routeReason} actor=${meta.actor} ${JSON.stringify(detail).slice(0, 1500)}`
}
