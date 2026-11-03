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

import { api } from './api'
import { subscribeSse, type SseSubscription } from './sse'

export type EventChannel = 'live-status' | 'workflow' | 'external-agents' | 'tasks' | 'inbox'

interface Listener {
  onEvent: (data: unknown) => void
  onError?: (error: unknown) => void
}

interface Frame {
  ch: EventChannel
  data: unknown
}

const listeners = new Map<EventChannel, Set<Listener>>()
/** Channels the open connection was asked for. */
let connected = new Set<EventChannel>()
let subscription: SseSubscription | null = null
let syncTimer: ReturnType<typeof setTimeout> | null = null

function wanted(): EventChannel[] {
  return [...listeners.keys()].sort()
}

function sync(): void {
  syncTimer = null
  const channels = wanted()
  if (channels.length === 0) {
    subscription?.close()
    subscription = null
    connected = new Set()
    return
  }
  if (subscription && channels.every((channel) => connected.has(channel))) return
  subscription?.close()
  connected = new Set(channels)
  subscription = subscribeSse<Frame>({
    url: () => api.eventStreamUrl(channels),
    onEvent: (frame) => {
      for (const listener of listeners.get(frame.ch) ?? []) listener.onEvent(frame.data)
    },
    onError: (error) => {
      for (const set of listeners.values()) for (const listener of set) listener.onError?.(error)
    },
  })
}

/** Batch the subscribes and unsubscribes of one render into one (re)connect. */
function scheduleSync(): void {
  if (syncTimer == null) syncTimer = setTimeout(sync, 0)
}

/**
 * Receive one channel's frames. `onError` fires when the shared connection fails
 * or drops; it reconnects by itself, like `subscribeSse`.
 */
export function subscribeEvents<T>(
  channel: EventChannel,
  handlers: { onEvent: (data: T) => void; onError?: (error: unknown) => void },
): SseSubscription {
  // The server sends each channel's own frames, so the payload is that channel's type.
  const listener: Listener = { onEvent: (data) => handlers.onEvent(data as T), onError: handlers.onError }
  let set = listeners.get(channel)
  if (!set) {
    set = new Set()
    listeners.set(channel, set)
  }
  set.add(listener)
  scheduleSync()
  let closed = false
  return {
    close() {
      if (closed) return
      closed = true
      const current = listeners.get(channel)
      current?.delete(listener)
      if (current?.size === 0) listeners.delete(channel)
      if (listeners.size === 0) scheduleSync()
    },
  }
}

/** Test seam: drop every listener and the connection. */
export function resetEventStreamForTests(): void {
  listeners.clear()
  if (syncTimer != null) clearTimeout(syncTimer)
  syncTimer = null
  subscription?.close()
  subscription = null
  connected = new Set()
}
