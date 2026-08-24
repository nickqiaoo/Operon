/**
 * Count of API requests currently in flight, so the shell can show that
 * *something* is loading even when the surface that asked for it has no
 * spinner of its own.
 *
 * Instrumented at `request()` / `softRequest()` rather than at a fetch patch on
 * purpose: those two funnel every JSON call in `api.ts`, while the streaming
 * paths (chat SSE, terminal WS, inbox/task event streams) build their URLs from
 * `getBaseUrl()` and fetch directly — a long-lived stream must not pin the
 * indicator on for its whole life.
 */

let inFlight = 0
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function beginRequest(): void {
  inFlight += 1
  emit()
}

export function endRequest(): void {
  // Clamp: a caller that somehow ends twice must not drive the count negative
  // and wedge the indicator off for every later request.
  inFlight = Math.max(0, inFlight - 1)
  emit()
}

/** Runs `fn`, counting it as in-flight until it settles. */
export async function trackRequest<T>(fn: () => Promise<T>): Promise<T> {
  beginRequest()
  try {
    return await fn()
  } finally {
    endRequest()
  }
}

export function getInFlightCount(): number {
  return inFlight
}

export function subscribeInFlight(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
