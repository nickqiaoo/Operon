import type { CodexSessionOptions, OpencodeSessionOptions, SessionOptions } from '@operon/agent-runtime'

/**
 * Session options as the app hands them to whichever provider a chat runs on:
 * the common ones, plus every provider's own block (`codex`, `opencode`). A
 * provider reads its block and ignores the others.
 */
export type HostSessionOptions = SessionOptions & CodexSessionOptions & OpencodeSessionOptions
