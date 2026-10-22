/** OpenCode 2, driven through one managed server and `@opencode/client` per runtime. */
export { opencode, type OpencodeMode } from './providers/opencode/index.js'
export type { OpencodeSessionNative, OpencodeSessionOptions } from './providers/opencode/session.js'
export { OPENCODE_CALLER_ARG, resolveOpencodeCaller } from './providers/opencode/caller-identity.js'
