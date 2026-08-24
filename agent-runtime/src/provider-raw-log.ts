import { createRuntimeLogger } from './logger.js'

/**
 * Raw upstream message dump, shared by every provider.
 *
 * When `OPERON_PROVIDER_RAW` is enabled, each message a provider receives from
 * its underlying agent — the Claude SDK message, a Codex JSON-RPC notification,
 * a Gemini stream event, a Kimi wire envelope, an opencode event, a cursor JSONL
 * line, a Copilot session event — is logged verbatim as JSON, tagged with the
 * provider id.
 *
 * This is the *upstream* view, captured before any normalization into
 * RuntimeStreamParts, so it answers "did the agent actually return this?" (e.g.
 * an empty reasoning block: was there no thinking text upstream, or did we drop
 * it while mapping?).
 *
 * Output goes through `console.debug` so `electron/main.ts` captures it into
 * `operon.log` (it wraps log/error/warn/debug, but not info). The logger is
 * forced verbose so the dump fires on this flag alone, independent of
 * `OPERON_VERBOSE`.
 */

const isEnvFlagEnabled = (value: string | undefined): boolean => {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

/** True when the raw-dump mode is on. Evaluated once at module load. */
export const PROVIDER_RAW_ENABLED = isEnvFlagEnabled(process.env.OPERON_PROVIDER_RAW)

const rawLogger = PROVIDER_RAW_ENABLED ? createRuntimeLogger('provider-raw', { verbose: true }) : null

/**
 * Individual string values longer than this are clipped, so a single large tool
 * result (e.g. a big file read) can't flood the log while still keeping every
 * reasoning / message / tool-input payload fully visible.
 */
const MAX_STRING = 20_000

function stringifyRaw(message: unknown): string {
  try {
    const json = JSON.stringify(message, (_key, value) =>
      typeof value === 'string' && value.length > MAX_STRING
        ? `${value.slice(0, MAX_STRING)}…(+${value.length - MAX_STRING} chars)`
        : value,
    )
    return json ?? String(message)
  } catch (error) {
    return `<<unserializable: ${error instanceof Error ? error.message : String(error)}>>`
  }
}

/**
 * Log one raw upstream message for a provider. A no-op unless
 * `OPERON_PROVIDER_RAW` is set, so it's cheap to leave on hot ingestion paths.
 */
export function logProviderRaw(providerId: string, message: unknown): void {
  if (!rawLogger) return
  rawLogger.debug(`[${providerId}] ${stringifyRaw(message)}`)
}
