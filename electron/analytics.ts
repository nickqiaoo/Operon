/**
 * Main-process analytics gate.
 *
 * The main process cannot answer two questions about its own events on its own:
 * whether the user consented (the flag lives in the renderer's localStorage)
 * and who they are (the distinct id is PostHog's, minted in the renderer). It
 * used to guess at both, and got both wrong: events were sent regardless of an
 * opt-out, breaking the promise that analytics can be turned off, and they were
 * attributed to a placeholder `main-<timestamp>` id that minted a brand-new
 * "user" on every launch, inflating unique-user counts with app starts.
 *
 * So nothing is sent until the renderer reports. Until then events are held,
 * and if the report never comes they are dropped — an opt-out that was never
 * heard has to be assumed.
 *
 * Extracted from main.ts to be testable: importing that module starts Electron.
 */

export interface NodeCapturePayload {
  distinctId: string
  event: string
  properties: Record<string, unknown>
}

export interface NodeAnalyticsSink {
  capture(payload: NodeCapturePayload): void
}

interface PendingEvent {
  event: string
  properties: Record<string, unknown>
}

export interface NodeAnalyticsOptions {
  /**
   * How long to hold events for a renderer that has not reported. A renderer
   * that crashed during boot, or a headless run, would otherwise buffer forever.
   */
  timeoutMs?: number
  /** Bounded so a silent renderer cannot grow the buffer without limit. */
  maxPending?: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_PENDING = 50

export interface NodeAnalytics {
  /** Record a main-process event, sending or buffering as consent allows. */
  capture(event: string, properties: Record<string, unknown>): void
  /**
   * Adopt the renderer's analytics state. Called on every report, not just the
   * first: `identify()` changes the distinct id mid-session, and consent can be
   * toggled in Settings at any time.
   */
  applyRendererState(distinctId: string, optedOut: boolean): void
  dispose(): void
}

export function createNodeAnalytics(
  sink: NodeAnalyticsSink,
  options: NodeAnalyticsOptions = {}
): NodeAnalytics {
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING
  let distinctId: string | null = null
  let optedOut = false
  let pending: PendingEvent[] = []

  const timer = setTimeout(() => {
    if (!distinctId) pending = []
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  // Never hold the process open for this.
  timer.unref?.()

  return {
    capture(event, properties) {
      if (optedOut) return
      // Main-process events are always the desktop app: nothing here runs in a
      // browser, PWA or native shell. Stamping it keeps one `app_platform`
      // breakdown valid across both clients.
      const enriched = { app_platform: 'desktop', ...properties }

      if (!distinctId) {
        if (pending.length < maxPending) pending.push({ event, properties: enriched })
        return
      }
      sink.capture({ distinctId, event, properties: enriched })
    },

    applyRendererState(nextDistinctId, nextOptedOut) {
      optedOut = nextOptedOut
      if (nextOptedOut || !nextDistinctId) {
        // Anything buffered was captured before we knew, and must not be sent.
        pending = []
        distinctId = null
        return
      }

      distinctId = nextDistinctId
      const buffered = pending
      pending = []
      for (const { event, properties } of buffered) {
        sink.capture({ distinctId: nextDistinctId, event, properties })
      }
    },

    dispose() {
      clearTimeout(timer)
      pending = []
    },
  }
}
