/**
 * The core: runtime, session types and errors. Providers live on their own
 * subpaths (`/claude-code`, `/codex`, `/opencode`, `/copilot`, `/acp`) so an app
 * only loads — and only installs the SDKs of — the agents it uses; `/ai-sdk`
 * turns a session's stream into a `useChat` stream, `/testing` has a fake agent.
 */

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

export { createRuntimeLogger, isRuntimeVerbose, type RuntimeLogger } from './logger.js'
export { readStreamAsAsyncIterable } from './utils/read-stream.js'
export { buildStreamMessageMetadata, type StreamMessageMetadata } from './stream-message-metadata.js'
export { getSessionIdFromProviderMetadata } from './stream-utils.js'
export {
  createTrafficRecorder,
  isTrafficRecordingEnabled,
  type TrafficRecorder,
  type TrafficRecorderContext,
} from './traffic-recorder.js'
