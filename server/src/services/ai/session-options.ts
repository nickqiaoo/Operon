import type { SessionOptions } from '@operon/agent-runtime'
import type { CodexSessionOptions } from '@operon/agent-runtime/codex'
import type { OpencodeSessionOptions } from '@operon/agent-runtime/opencode'
import type { QoderSessionOptions } from '@operon/agent-runtime/qoder'
import type { OperonSessionOptions } from '../operon-runtime/index.js'
import type { RemoteExecutionRef } from '@shared/delegations'

/**
 * Session options as the app hands them to whichever provider a chat runs on:
 * the common ones, plus every provider's own block (`codex`, `opencode`, `qoder`, `operon`). A
 * provider reads its block and ignores the others.
 */
export type HostSessionOptions = SessionOptions & CodexSessionOptions & OpencodeSessionOptions & QoderSessionOptions & OperonSessionOptions & {
  /** The agent runs on another machine of the account (a remote external agent). */
  remoteExecution?: RemoteExecutionRef
}
