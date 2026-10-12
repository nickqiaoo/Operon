/** A scriptable stand-in agent, for testing a host without any agent CLI installed. */
export { fakeAgent, FakeRuntimeProvider } from './providers/fake/index.js'
export type { FakeScript, FakeScriptCtx, FakeSessionState } from './providers/fake/index.js'
export { BUILTIN_SCRIPT_NAMES } from './providers/fake/scripts/index.js'
