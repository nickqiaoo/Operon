// Public type surface — everything declared in types.ts.
export type * from './types.js'
// Values (not just types) the host needs at runtime — the error class lets a
// host tell a message written for the user from an internal failure.
export { UserFacingRuntimeError, isUserFacingRuntimeError, RuntimeInjectionUnavailableError } from './types.js'

export {
  createRuntime,
  defineProvider,
  type Runtime,
  type RuntimeConfig,
  type ProviderDefinition,
  type ProviderTypes,
  type AnyProviderDefinition,
  type ProviderIdOf,
  type ProviderOf,
  type ProviderNativeOf,
  type SessionNativeOf,
  type SessionOptionsOf,
} from './runtime.js'
export { createRuntimeContext, type RuntimeContext, type RuntimeHost } from './context.js'

export { claudeCode, type ClaudeCodeNative, type ClaudeCodeEffort } from './providers/claude/index.js'
export type { ClaudeSessionNative } from './providers/claude/session.js'
export { codex, type CodexNative, type CodexEffort } from './providers/codex/index.js'
export type { CodexSessionNative } from './providers/codex/session.js'
export type { CodexModeId, CodexOptions, CodexSessionOptions } from './providers/codex/config.js'
export { copilot } from './providers/copilot/index.js'
export { opencode, type OpencodeMode } from './providers/opencode/index.js'
export type { OpencodeSessionNative, OpencodeSessionOptions } from './providers/opencode/session.js'
export { cursor, type CursorMode } from './providers/cursor/index.js'
export { grok, type GrokMode } from './providers/grok/index.js'
export { kimi, type KimiMode } from './providers/kimi/index.js'
export { antigravity, type AntigravityMode } from './providers/antigravity/index.js'

export { createRuntimeLogger, isRuntimeVerbose, type RuntimeLogger } from './logger.js'
export { readStreamAsAsyncIterable } from './utils/read-stream.js'
export type { CodexGoal } from './providers/codex/sdk/protocol/index.js'
export { buildStreamMessageMetadata, type StreamMessageMetadata } from './stream-message-metadata.js'
export { getSessionIdFromProviderMetadata } from './stream-utils.js'
export type { ClaudeSubagentStep, ClaudeSubagentTranscript } from './providers/claude/subagent-transcript.js'
export type { AccountRateLimitsReadResult } from './providers/codex/sdk/protocol/index.js'

export { OPENCODE_CALLER_ARG, resolveOpencodeCaller } from './providers/opencode/caller-identity.js'
export { FakeRuntimeProvider, fakeAgent } from './providers/fake/index.js'
export type { FakeScript, FakeScriptCtx, FakeSessionState } from './providers/fake/index.js'
export { BUILTIN_SCRIPT_NAMES } from './providers/fake/scripts/index.js'
export {
  createTrafficRecorder,
  isTrafficRecordingEnabled,
  type TrafficRecorder,
  type TrafficRecorderContext,
} from './traffic-recorder.js'

import { claudeCode } from './providers/claude/index.js'
import { codex } from './providers/codex/index.js'
import { copilot } from './providers/copilot/index.js'
import { opencode } from './providers/opencode/index.js'
import { cursor } from './providers/cursor/index.js'
import { grok } from './providers/grok/index.js'
import { kimi } from './providers/kimi/index.js'
import { antigravity } from './providers/antigravity/index.js'

/** Every built-in coding-agent provider, in the order a picker would list them. */
export const builtinProviders = () =>
  [claudeCode(), codex(), grok(), kimi(), opencode(), cursor(), antigravity(), copilot()] as const
