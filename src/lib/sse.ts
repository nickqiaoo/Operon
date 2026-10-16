/**
 * Shared consumer for the app's `data: `-framed SSE endpoints.
 *
 * This exists because the task / inbox / channel hooks each owned a
 * line-for-line copy of the same reader loop, and every copy shared the same two
 * holes:
 *
 *   1. A server-side close arrives as `done`, not as a throw. Reconnect lived
 *      only in the `catch`, so `done` fell out of the loop and returned
 *      normally — the stream went quiet *permanently* until the component
 *      remounted. Server restarts and idle-timeouts on the remote tunnel take
 *      exactly that path, which is why the symptom was "live updates work for a
 *      while, then silently stop".
 *   2. Nothing checked `response.ok`, so an HTML 502 from the tunnel was handed
 *      to the line parser as though it were an event stream.
 *
 * `EventSource` would give reconnect for free, but it can't carry auth headers,
 * which the remote-tunnel path needs — hence fetch + reader.
 */

import { apiAuthHeaders } from './api-client.js'

const INITIAL_RETRY_MS = 1_000
const DEFAULT_MAX_RETRY_MS = 30_000

/**
 * A stream that stayed OPEN this long counts as healthy, so its drop is a new
 * incident and backoff restarts from the bottom. Without this, a stream that
 * reconnects fine but gets recycled hourly would keep inheriting the delay from
 * an unrelated older failure and eventually wait the full cap before recovering.
 *
 * Measured from the moment the response headers arrive, NOT from the start of
 * the attempt: connect latency is not uptime. Timing it from before the fetch
 * meant a half-dead tunnel that takes longer than this to fail would look
 * "healthy" on every single failure, reset the delay, and turn the backoff into
 * a 1s retry storm — the exact case the backoff exists to prevent.
 */
const HEALTHY_MS = 5_000

/**
 * Hidden at least this long, the stream is replaced when the page comes back. A phone suspends a
 * backgrounded app and the system drops its sockets, but WebKit doesn't always say so: the read
 * can sit there forever on a dead connection while the screen shows what it showed before.
 * Coming back to the foreground is the moment the user looks, so don't wait to find out.
 */
const HIDDEN_RECONNECT_MS = 2_000

/**
 * Whether the browser itself says there is no network. `false` when the answer
 * is unknown (non-browser env), so those callers keep the plain timer path.
 *
 * `onLine === true` is not a promise of reachability, which is why this is only
 * consulted to *suppress* attempts, never to declare the connection good.
 */
function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

export interface SseSubscription {
  /** Stops reading, cancels any pending reconnect, and aborts the request. */
  close(): void
}

export interface SubscribeSseOptions<T> {
  /** Resolved per attempt, so a reconnect picks up a rotated token or node id. */
  url: () => Promise<string>
  onEvent: (event: T) => void
  /** Called for a frame that isn't valid JSON. Default: ignore. */
  onParseError?: (error: unknown, raw: string) => void
  /** Called when an attempt fails or the stream drops. Default: ignore. */
  onError?: (error: unknown) => void
  maxRetryMs?: number
}

export function subscribeSse<T>({
  url,
  onEvent,
  onParseError,
  onError,
  maxRetryMs = DEFAULT_MAX_RETRY_MS,
}: SubscribeSseOptions<T>): SseSubscription {
  let closed = false
  /** The current attempt's request, aborted when it is replaced or the subscription closes. */
  let ac = new AbortController()
  /** Bumped per attempt: one that was replaced (see `reconnectNow`) must not schedule a retry. */
  let attempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryDelay = INITIAL_RETRY_MS
  let onlineListener: (() => void) | null = null

  const detachOnline = () => {
    if (onlineListener == null) return
    window.removeEventListener('online', onlineListener)
    onlineListener = null
  }

  /**
   * Park until the browser reports a network again, instead of burning timer
   * ticks on fetches it will refuse to send. Also what makes recovery prompt:
   * an app holding several of these open would otherwise have each stream sit
   * out the rest of its backoff (up to `maxRetryMs`) after the network is back.
   */
  const waitForOnline = () => {
    if (closed || onlineListener != null) return
    onlineListener = () => {
      detachOnline()
      if (closed) return
      // Regaining the network is not another failure — it is the condition that
      // made the previous ones meaningless. Retry immediately, from the bottom.
      retryDelay = INITIAL_RETRY_MS
      void run()
    }
    window.addEventListener('online', onlineListener)
  }

  const scheduleRetry = () => {
    if (closed || retryTimer != null) return
    // No network at all: every scheduled attempt would fail before leaving the
    // browser and log a console error doing it. Wait for the `online` event.
    if (isOffline()) {
      waitForOnline()
      return
    }
    // Jitter so a server restart doesn't bring every open window back in lockstep.
    const wait = retryDelay + Math.random() * 500
    retryDelay = Math.min(retryDelay * 2, maxRetryMs)
    retryTimer = setTimeout(() => {
      retryTimer = null
      void run()
    }, wait)
  }

  const run = async () => {
    if (closed) return
    if (isOffline()) {
      waitForOnline()
      return
    }
    const self = ++attempt
    ac = new AbortController()
    const signal = ac.signal
    // Null until the response headers land, so an attempt that never connected
    // can't be mistaken for a healthy stream that dropped. See HEALTHY_MS.
    let connectedAt: number | null = null
    try {
      // Auth headers resolve after `url()` — every producer of these URLs goes
      // through `getBaseUrl()`, which primes the token on its first await.
      const response = await fetch(await url(), { signal, headers: apiAuthHeaders() })
      if (!response.ok || response.body == null) {
        throw new Error(`SSE request failed: ${response.status} ${response.statusText}`)
      }
      connectedAt = Date.now()

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (!closed && self === attempt) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (!raw) continue
          try {
            onEvent(JSON.parse(raw) as T)
          } catch (error) {
            onParseError?.(error, raw)
          }
        }
      }
    } catch (error) {
      // `close()` aborts the fetch, which surfaces here as an AbortError; the
      // `closed` guard below is what distinguishes that from a real failure.
      if (!closed && self === attempt) onError?.(error)
    }

    // Reached on `done` as well — a clean close from the server is still a
    // disconnect. This is the fall-through the per-hook copies never handled.
    // A replaced attempt leaves the retrying to the one that replaced it.
    if (closed || self !== attempt) return
    if (connectedAt != null && Date.now() - connectedAt >= HEALTHY_MS) {
      retryDelay = INITIAL_RETRY_MS
    }
    scheduleRetry()
  }

  /** Drop whatever attempt is in flight or waiting and connect again, from the bottom of the backoff. */
  const reconnectNow = () => {
    if (closed) return
    if (retryTimer != null) clearTimeout(retryTimer)
    retryTimer = null
    detachOnline()
    retryDelay = INITIAL_RETRY_MS
    attempt++
    ac.abort()
    void run()
  }

  let hiddenAt: number | null = null
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
      return
    }
    const away = hiddenAt == null ? 0 : Date.now() - hiddenAt
    hiddenAt = null
    if (away >= HIDDEN_RECONNECT_MS) reconnectNow()
  }
  const watchesVisibility = typeof document !== 'undefined'
  if (watchesVisibility) document.addEventListener('visibilitychange', onVisibility)

  void run()

  return {
    close() {
      closed = true
      if (retryTimer != null) clearTimeout(retryTimer)
      retryTimer = null
      detachOnline()
      if (watchesVisibility) document.removeEventListener('visibilitychange', onVisibility)
      ac.abort()
    },
  }
}
