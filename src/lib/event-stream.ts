/**
 * The app's always-open feeds, on ONE connection (`GET /api/events`).
 *
 * The desktop renderer talks to the local server over HTTP/1.1, where Chromium
 * allows six connections per host. These five feeds stay open for the whole
 * session; held as separate streams, a running chat's own stream used the sixth
 * and every request after it — answering a permission prompt, a steer — queued
 * forever. Electron lifts the limit with a switch, a plain browser cannot.
 *
 * Callers subscribe to a channel as they would to its own stream. Subscribers
 * that mount together share one connect: a channel joining later reconnects the
 * stream, and every channel opens with a full snapshot, so the others simply
 * resync. A channel whose last subscriber leaves stays on the wire until the
 * next reconnect — its frames are dropped here — rather than costing a reconnect
 * of its own.
 */

import { api, apiFor } from './api'
import { transportFor } from './api-client'
import { nodeKeyOf, type NodeKey } from './chat-ref'
import { subscribeSse, type SseSubscription } from './sse'

export type EventChannel = 'codex-selection' | 'chat-status' | 'workflow' | 'external-agents' | 'tasks' | 'inbox' | 'projects'

interface Listener {
  onEvent: (data: unknown) => void
  onError?: (error: unknown) => void
}

interface Frame {
  ch: EventChannel
  data: unknown
}

/**
 * One machine's connection. This machine has one; another machine of the
 * account gets its own while something (a tab showing one of its chats) listens
 * to it, through the local server's relay.
 */
interface Hub {
  nodeId: string | undefined
  listeners: Map<EventChannel, Set<Listener>>
  /** Channels the open connection was asked for. */
  connected: Set<EventChannel>
  subscription: SseSubscription | null
  syncTimer: ReturnType<typeof setTimeout> | null
}

const hubs = new Map<NodeKey, Hub>()

function hubFor(nodeId: string | undefined): Hub {
  const key = nodeKeyOf(nodeId)
  let hub = hubs.get(key)
  if (!hub) {
    hub = { nodeId, listeners: new Map(), connected: new Set(), subscription: null, syncTimer: null }
    hubs.set(key, hub)
  }
  return hub
}

function wanted(hub: Hub): EventChannel[] {
  return [...hub.listeners.keys()].sort()
}

function sync(hub: Hub): void {
  hub.syncTimer = null
  const channels = wanted(hub)
  if (channels.length === 0) {
    hub.subscription?.close()
    hub.subscription = null
    hub.connected = new Set()
    // A remote machine nobody listens to any more is forgotten; this one is kept.
    if (hub.nodeId) hubs.delete(nodeKeyOf(hub.nodeId))
    return
  }
  if (hub.subscription && channels.every((channel) => hub.connected.has(channel))) return
  hub.subscription?.close()
  hub.connected = new Set(channels)
  const { nodeId } = hub
  hub.subscription = subscribeSse<Frame>({
    // `api` is read here rather than through `apiFor` so the local path stays
    // exactly what it was (and what tests mock).
    url: () => (nodeId ? apiFor(nodeId) : api).eventStreamUrl(channels),
    ...(nodeId ? { headers: () => transportFor(nodeId).authHeaders() } : {}),
    onEvent: (frame) => {
      for (const listener of hub.listeners.get(frame.ch) ?? []) listener.onEvent(frame.data)
    },
    onError: (error) => {
      for (const set of hub.listeners.values()) for (const listener of set) listener.onError?.(error)
    },
  })
}

/** Batch the subscribes and unsubscribes of one render into one (re)connect. */
function scheduleSync(hub: Hub): void {
  if (hub.syncTimer == null) hub.syncTimer = setTimeout(() => sync(hub), 0)
}

/**
 * Receive one channel's frames from one machine (`nodeId` undefined: this
 * one). `onError` fires when the shared connection fails or drops; it
 * reconnects by itself, like `subscribeSse`.
 */
export function subscribeEvents<T>(
  channel: EventChannel,
  handlers: { onEvent: (data: T) => void; onError?: (error: unknown) => void },
  nodeId?: string,
): SseSubscription {
  const hub = hubFor(nodeId)
  // The server sends each channel's own frames, so the payload is that channel's type.
  const listener: Listener = { onEvent: (data) => handlers.onEvent(data as T), onError: handlers.onError }
  let set = hub.listeners.get(channel)
  if (!set) {
    set = new Set()
    hub.listeners.set(channel, set)
  }
  set.add(listener)
  scheduleSync(hub)
  let closed = false
  return {
    close() {
      if (closed) return
      closed = true
      const current = hub.listeners.get(channel)
      current?.delete(listener)
      if (current?.size === 0) hub.listeners.delete(channel)
      if (hub.listeners.size === 0) scheduleSync(hub)
    },
  }
}

/** Test seam: drop every listener and connection. */
export function resetEventStreamForTests(): void {
  for (const hub of hubs.values()) {
    hub.listeners.clear()
    if (hub.syncTimer != null) clearTimeout(hub.syncTimer)
    hub.subscription?.close()
  }
  hubs.clear()
}
