// Public type surface — everything declared in types.ts.
export type * from './types.js'

export { SessionManager } from './session-manager.js'
export { setRuntimeHost, getRuntimeHost, type RuntimeHost } from './host.js'
export { createRuntimeLogger, isRuntimeVerbose, type RuntimeLogger } from './logger.js'
export { readStreamAsAsyncIterable } from './utils/read-stream.js'
export { MEMORY_RESOLVER_PROMPT, FILE_REFERENCE_PROMPT } from './memory-resolver-prompt.js'
export type { CodexGoal } from './providers/codex/sdk/protocol/index.js'
export { buildStreamMessageMetadata, type StreamMessageMetadata } from './stream-message-metadata.js'
export { getSessionIdFromProviderMetadata } from './stream-utils.js'
export {
  getClaudeAccountUsage,
  disposeClaudeUsageProbe,
} from './providers/claude/usage-probe.js'

import { SessionManager } from './session-manager.js'
import { setRuntimeHost, type RuntimeHost } from './host.js'
import type { ProviderInfo, RuntimeProviderFactory } from './types.js'
import { ClaudeRuntimeProvider } from './providers/claude/index.js'
import { CodexRuntimeProvider } from './providers/codex/index.js'
import { GeminiRuntimeProvider } from './providers/gemini/index.js'
import { GrokRuntimeProvider } from './providers/grok/index.js'
import { KimiRuntimeProvider } from './providers/kimi/index.js'
import { OpencodeRuntimeProvider } from './providers/opencode/index.js'
import { CursorRuntimeProvider } from './providers/cursor/index.js'
import { CopilotRuntimeProvider } from './providers/copilot/index.js'
import { FakeRuntimeProvider } from './providers/fake/index.js'
import './providers/fake/scripts/index.js'

/** A provider factory class: no-arg constructable + a static descriptor. */
export interface RuntimeProviderClass {
  new (): RuntimeProviderFactory
  readonly providerInfo: ProviderInfo
}

export { FakeRuntimeProvider } from './providers/fake/index.js'
export type { FakeScript, FakeScriptCtx, FakeSessionState } from './providers/fake/index.js'
export { BUILTIN_SCRIPT_NAMES } from './providers/fake/scripts/index.js'
export {
  createTrafficRecorder,
  isTrafficRecordingEnabled,
  type TrafficRecorder,
  type TrafficRecorderContext,
} from './traffic-recorder.js'

/**
 * Build a SessionManager with the built-in providers registered. The embedding
 * app supplies its host and any app-specific providers (e.g. the operon agent)
 * via `extraProviders`, which are registered on top of the built-ins.
 */
export function createSessionManager(
  host?: RuntimeHost,
  extraProviders: RuntimeProviderClass[] = [],
): SessionManager {
  if (host) setRuntimeHost(host)
  const manager = new SessionManager()
  const providers: RuntimeProviderClass[] = [
    ClaudeRuntimeProvider,
    CodexRuntimeProvider,
    GeminiRuntimeProvider,
    GrokRuntimeProvider,
    KimiRuntimeProvider,
    OpencodeRuntimeProvider,
    CursorRuntimeProvider,
    CopilotRuntimeProvider,
    ...(process.env.OPERON_ENABLE_FAKE_RUNTIME === '1' ? [FakeRuntimeProvider] : []),
    ...extraProviders,
  ]

  for (const ProviderClass of providers) {
    const { providerInfo } = ProviderClass
    manager.register(providerInfo.id, () => new ProviderClass(), providerInfo)
  }

  return manager
}
