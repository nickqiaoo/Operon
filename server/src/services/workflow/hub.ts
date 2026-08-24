/**
 * Live fan-out of persisted workflow events.
 *
 * The hub carries no state. It exists only to tell already-connected readers
 * that the log grew — every event it publishes has already been written, and any
 * reader can catch up on what it missed by reading from its last id. That is the
 * difference from the old hub, which was the ONLY carrier of sub-agent output:
 * miss the moment and the bytes were gone, so a page refresh lost a running
 * agent's history and there was no way to get it back.
 *
 * Two scopes, one list:
 *   - global subscribers get every run's events (the panel's feed);
 *   - run-scoped subscribers get one run's, including its high-volume chunks.
 */

import type { StoredWorkflowEvent } from './events.js'

type Listener = (event: StoredWorkflowEvent) => void

const globalListeners = new Set<Listener>()
const runListeners = new Map<string, Set<Listener>>()

/**
 * Subscribe to events. `runId === null` subscribes to every run.
 *
 * Returns the unsubscribe function. A listener that throws is isolated — one
 * broken SSE connection must not stop the others from being told.
 */
export function subscribeWorkflowEvents(runId: string | null, listener: Listener): () => void {
  if (runId === null) {
    globalListeners.add(listener)
    return () => globalListeners.delete(listener)
  }
  let set = runListeners.get(runId)
  if (!set) {
    set = new Set()
    runListeners.set(runId, set)
  }
  set.add(listener)
  return () => {
    const current = runListeners.get(runId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) runListeners.delete(runId)
  }
}

/** Publish one already-persisted event to everyone watching. */
export function publishWorkflowEvent(event: StoredWorkflowEvent): void {
  for (const listener of [...globalListeners, ...(runListeners.get(event.runId) ?? [])]) {
    try {
      listener(event)
    } catch (error) {
      console.warn('[workflow] event listener failed:', error)
    }
  }
}
