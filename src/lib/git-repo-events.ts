import { apiAuthHeaders, getBaseUrl } from './api-client.js'
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

const listeners = new Set<Listener>()

/** Non-null exactly while at least one listener is registered. */
let subscription: SseSubscription | null = null

function ensureSSE(): void {
  if (subscription != null) return
  subscription = subscribeSse<GitRepoChangedEvent>({
    url: async () => `${await getBaseUrl()}/git/watch-events`,
    onEvent: (event) => {
      for (const cb of listeners) cb(event)
    },
    onParseError: (e) => console.warn('[git-repo-events] failed to parse event:', e),
    onError: (e) => console.warn('[git-repo-events] stream dropped:', e),
  })
}

function releaseSSE(): void {
  if (listeners.size > 0) return
  subscription?.close()
  subscription = null
}

/**
 * Start (or ref-count) a server-side watcher for `root`. Does not open the
 * stream: `subscribe` owns its lifetime, and callers pair the two (see
 * `useGitRepoInvalidation`). Opening it here would leak a stream that no
 * unsubscribe is ever going to close.
 */
export async function watchRepo(root: string): Promise<void> {
  const baseUrl = await getBaseUrl()
  await fetch(`${baseUrl}/git/watch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
    body: JSON.stringify({ root }),
  }).catch((e) => console.warn('[git-repo-events] watch failed:', e))
}

/** Release one reference to the watcher for `root`. */
export async function unwatchRepo(root: string): Promise<void> {
  const baseUrl = await getBaseUrl()
  await fetch(`${baseUrl}/git/unwatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
    body: JSON.stringify({ root }),
  }).catch((e) => console.warn('[git-repo-events] unwatch failed:', e))
}

/** Subscribe to git-repo-changed events. Returns an unsubscribe function. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  ensureSSE()
  return () => {
    listeners.delete(listener)
    // The stream used to outlive every listener — nothing ever aborted it, so it
    // stayed open (and reconnecting) for the rest of the session while its events
    // were fanned out to an empty set.
    releaseSSE()
  }
}
