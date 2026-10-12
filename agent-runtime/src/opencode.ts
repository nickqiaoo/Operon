/** OpenCode, driven through one `opencode serve` per runtime. Needs `@opencode-ai/sdk` (a peer dependency). */
export { opencode, type OpencodeMode } from './providers/opencode/index.js'
export type { OpencodeSessionNative, OpencodeSessionOptions } from './providers/opencode/session.js'
export { OPENCODE_CALLER_ARG, resolveOpencodeCaller } from './providers/opencode/caller-identity.js'
