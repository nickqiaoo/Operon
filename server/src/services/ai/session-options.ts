import type { SessionOptions } from '@operon/agent-runtime'
import type { CodexSessionOptions } from '@operon/agent-runtime/codex'
import type { OpencodeSessionOptions } from '@operon/agent-runtime/opencode'

/**
 * Session options as the app hands them to whichever provider a chat runs on:
 * the common ones, plus every provider's own block (`codex`, `opencode`). A
 * provider reads its block and ignores the others.
 */
export type HostSessionOptions = SessionOptions & CodexSessionOptions & OpencodeSessionOptions
