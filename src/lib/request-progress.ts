/**
 * Count of the loads that are worth a top-of-window progress bar, so the shell
 * can show that *something* is loading even when the surface that asked for it
 * has no spinner of its own.
 *
 * Opt-in, one call site at a time — NOT wired into `request()` / `softRequest()`
 * in `api.ts`. Instrumenting those meant every background poll (chat previews,
 * usage probes, git status, inbox counts) lit the bar, so it was on more or less
 * permanently and stopped carrying any information. Wrap a call here only when
 * the user just did something and is staring at an empty surface until it
 * returns — today that is opening a conversation and waiting for its transcript.
 * Background refreshes and long-lived streams must stay out.
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
