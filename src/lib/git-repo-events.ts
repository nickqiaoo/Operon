import { localTransport, type ApiTransport } from './api-client.js'
import { subscribeSse, type SseSubscription } from './sse.js'

/**
 * Client side of the git-repo-watcher bridge. Mirrors Codex's
 * `git.subscribe('git-repo-changed', …)`: components register a listener and
 * ref-count a watcher for a repo root; a single shared SSE stream fans the
 * server's events out to every listener.
 */

export type GitChangeType = 'head' | 'index' | 'remote-refs' | 'working-tree'

export interface GitRepoChangedEvent {
  type: 'git-repo-changed'
  changeType: GitChangeType
  root: string
  commonDir: string
  rebaseInProgress: boolean | null
  changedPaths?: string[]
}

type Listener = (event: GitRepoChangedEvent) => void

/** One machine's watch stream. Another machine's goes through this server's relay. */
interface Hub {
  listeners: Set<Listener>
  /** Non-null exactly while at least one listener is registered. */
  subscription: SseSubscription | null
}

const hubs = new Map<ApiTransport, Hub>()

function hubFor(transport: ApiTransport): Hub {
  let hub = hubs.get(transport)
  if (!hub) {
    hub = { listeners: new Set(), subscription: null }
    hubs.set(transport, hub)
  }
  return hub
}

function ensureSSE(transport: ApiTransport, hub: Hub): void {
  if (hub.subscription != null) return
  hub.subscription = subscribeSse<GitRepoChangedEvent>({
    url: async () => `${await transport.baseUrl()}/git/watch-events`,
    headers: () => transport.authHeaders(),
    onEvent: (event) => {
      for (const cb of hub.listeners) cb(event)
    },
    onParseError: (e) => console.warn('[git-repo-events] failed to parse event:', e),
    onError: (e) => console.warn('[git-repo-events] stream dropped:', e),
  })
}

function releaseSSE(transport: ApiTransport, hub: Hub): void {
  if (hub.listeners.size > 0) return
  hub.subscription?.close()
  hub.subscription = null
  if (transport !== localTransport) hubs.delete(transport)
}

/**
 * Start (or ref-count) a server-side watcher for `root` on the machine
 * `transport` reaches. Does not open the stream: `subscribe` owns its
 * lifetime, and callers pair the two (see `useGitRepoInvalidation`). Opening
 * it here would leak a stream that no unsubscribe is ever going to close.
 */
export async function watchRepo(root: string, transport: ApiTransport = localTransport): Promise<void> {
  const baseUrl = await transport.baseUrl()
  await fetch(`${baseUrl}/git/watch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...transport.authHeaders() },
    body: JSON.stringify({ root }),
  }).catch((e) => console.warn('[git-repo-events] watch failed:', e))
}

/** Release one reference to the watcher for `root`. */
export async function unwatchRepo(root: string, transport: ApiTransport = localTransport): Promise<void> {
  const baseUrl = await transport.baseUrl()
  await fetch(`${baseUrl}/git/unwatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...transport.authHeaders() },
    body: JSON.stringify({ root }),
  }).catch((e) => console.warn('[git-repo-events] unwatch failed:', e))
}

/** Subscribe to one machine's git-repo-changed events. Returns an unsubscribe function. */
export function subscribe(listener: Listener, transport: ApiTransport = localTransport): () => void {
  const hub = hubFor(transport)
  hub.listeners.add(listener)
  ensureSSE(transport, hub)
  return () => {
    hub.listeners.delete(listener)
    // The stream used to outlive every listener — nothing ever aborted it, so it
    // stayed open (and reconnecting) for the rest of the session while its events
    // were fanned out to an empty set.
    releaseSSE(transport, hub)
  }
}
