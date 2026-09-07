/**
 * The process's one telemetry service.
 *
 * Built by `startServer` when the host hands over an analytics sink, which on desktop is the
 * main-process `NodeAnalytics` (electron/analytics.ts): it holds events until the renderer has
 * reported consent and a distinct id, and drops them on opt-out. The framework's
 * `PostHogAppender` wraps that sink in injected mode, so there is exactly one PostHog channel
 * and the consent gate stays where it is. Headless runs pass no sink and nothing is counted.
 *
 * Two registries share the service: the framework's (turn / tool / compaction … projected from
 * the operon provider's event stream, subscribed automatically once the harness gets the
 * service) and ours (`shared/telemetry/events.ts`), reached through `productTelemetry()`.
 */

import { createTelemetryService, noopTelemetryService, PostHogAppender, type TelemetryService } from 'operon-agents/telemetry'
import { PRODUCT_TELEMETRY_EVENTS, type ProductTelemetryEvents } from '@shared/telemetry/events'

export type AnalyticsCapture = (event: string, properties: Record<string, unknown>) => void

let service: TelemetryService = noopTelemetryService

/** Wire the host's analytics sink. Called once from `startServer`; a no-op service until then. */
export function initTelemetry(capture: AnalyticsCapture, appVersion?: string): TelemetryService {
  const created = createTelemetryService()
  created.addAppender(
    new PostHogAppender({
      client: { capture: (message) => capture(message.event, message.properties) },
      app: { name: 'operon', version: appVersion },
    })
  )
  service = created
  return created
}

/** Test seam: swap the process service (pass `noopTelemetryService` to silence). */
export function setTelemetryService(next: TelemetryService): void {
  service = next
}

/** The framework-typed service, to hand to `createLocalHarness({ telemetry })`. */
export function getTelemetry(): TelemetryService {
  return service
}

/** Our registry over the same service. */
export function productTelemetry(): TelemetryService<ProductTelemetryEvents> {
  return service.withRegistry(PRODUCT_TELEMETRY_EVENTS)
}

/** Drain the appender before exit; the host calls this ahead of its own PostHog shutdown. */
export async function shutdownTelemetry(): Promise<void> {
  const current = service
  service = noopTelemetryService
  await current.shutdown()
}
