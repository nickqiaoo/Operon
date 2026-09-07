/**
 * Local-debug tracing for the Operon runtime: every run (a prompt and everything it triggers)
 * becomes one OpenTelemetry trace — agents, turns, model generations with the prompt / messages /
 * output, tool calls with args / results, sub-agents — shipped over OTLP/HTTP to a collector on
 * this machine (Jaeger, Tempo, …).
 *
 * Off unless `OPERON_TRACING` is set. Nothing leaves the process otherwise: no provider is
 * built, no exporter is created, and the harness gets no `T.Tracing` registration at all.
 *
 *   OPERON_TRACING=1        content "delta": system prompt, the messages the model had not yet
 *                           answered, output, tool args/results  (what you want for debugging)
 *   OPERON_TRACING=full     like delta, but every generation carries the ENTIRE context
 *   OPERON_TRACING=metadata span tree + model ids + token counts only, no conversation content
 *
 * The collector endpoint follows the standard OTel variables (`OTEL_EXPORTER_OTLP_ENDPOINT`,
 * default `http://localhost:4318`). Try it:
 *
 *   docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:2.9.0
 *   OPERON_TRACING=1 npm run dev
 *
 * then open http://localhost:16686, service `operon`. All runs of one conversation share the
 * tag `gen_ai.conversation.id` (the session id).
 */
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { OTelTracingProcessor, type TracingContentMode, type TracingProcessor } from 'operon-agents/tracing'

const SERVICE_NAME = 'operon'

let active: OTelTracingProcessor | undefined

function contentModeFromEnv(): TracingContentMode | undefined {
  const raw = (process.env.OPERON_TRACING ?? '').trim().toLowerCase()
  if (raw === '' || raw === '0' || raw === 'false' || raw === 'off') return undefined
  if (raw === 'full') return 'full'
  if (raw === 'metadata' || raw === 'none') return 'none'
  return 'delta'
}

/**
 * The processor to register as `T.Tracing`, or undefined when tracing is off. Built once per
 * process; the harness is built once too, so the two lifetimes match.
 */
export function createOperonTracing(): TracingProcessor | undefined {
  if (active) return active
  const content = contentModeFromEnv()
  if (content === undefined) return undefined
  const exporter = new OTLPTraceExporter()
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': SERVICE_NAME,
      ...(process.env.npm_package_version ? { 'service.version': process.env.npm_package_version } : {}),
    }),
    // A short delay so a run shows up in the viewer about as soon as it finishes; this is a
    // debugging aid, not a production pipeline.
    spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 1000 })],
  })
  active = new OTelTracingProcessor({
    tracer: provider.getTracer(SERVICE_NAME),
    tracerProvider: provider,
    providerName: SERVICE_NAME,
    content,
    shutdownProvider: true,
  })
  console.log(`[operon] tracing on (content=${content}) → ${process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318'}`)
  return active
}

/** Flush what is still buffered and stop the exporter. Safe to call when tracing is off. */
export async function shutdownOperonTracing(): Promise<void> {
  const processor = active
  active = undefined
  if (!processor) return
  try {
    await processor.shutdown()
  } catch (error) {
    console.warn('[operon] tracing shutdown failed', error)
  }
}
