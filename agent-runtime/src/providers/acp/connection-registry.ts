/**
 * Shared ACP agent processes.
 *
 * ACP is session-multiplexed in the same way the codex app-server is: an agent
 * hands out session ids from `session/new`, and every message afterwards —
 * `session/prompt`, `session/update`, `session/request_permission` — names the
 * session it belongs to. So one spawned CLI can carry every conversation that
 * wants the same agent, rather than one process per chat.
 *
 * Connections are keyed by everything that is fixed at spawn time. `cwd` is part
 * of the key even though `session/new` takes its own: agents resolve project
 * config (`.cursor/`, `.grok/`, …) against the process working directory, so
 * sharing one across workspaces would quietly give a conversation another
 * project's settings. Within a workspace this still collapses N chats to one
 * process, which is the win.
 */

import type * as acp from '@zed-industries/agent-client-protocol'
import { createRuntimeLogger } from '../../logger.js'
import { ACP_PROTOCOL_VERSION, AcpConnection } from './connection.js'

export interface AcquireAcpOptions {
  providerId: string
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  onStderr?: (line: string) => void
}

export interface AcpLease {
  connection: AcpConnection
  /** The one-time handshake result, shared by every session on this connection. */
  initialize: acp.InitializeResponse
  release: () => void
}

interface Entry {
  connection: AcpConnection
  initialize: Promise<acp.InitializeResponse>
  refCount: number
}

const connections = new Map<string, Entry>()
const logger = createRuntimeLogger('acp-connections')

function connectionKey(options: AcquireAcpOptions): string {
  return JSON.stringify([
    options.providerId,
    options.command,
    options.args,
    options.cwd,
    options.env,
  ])
}

export async function acquireAcpConnection(options: AcquireAcpOptions): Promise<AcpLease> {
  const key = connectionKey(options)
  let entry = connections.get(key)

  if (!entry) {
    logger.info(
      `Starting ${options.providerId} ACP agent: ${options.command} ${options.args.join(' ')} (cwd ${options.cwd})`,
    )
    const connection = new AcpConnection({
      providerId: options.providerId,
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      callbacks: { onStderr: options.onStderr },
      // Drop a dead process from the registry so the next session spawns a fresh
      // one instead of inheriting a corpse. Sessions already learned it died
      // through their own onExit.
      onProcessExit: () => {
        if (connections.get(key) === entry) connections.delete(key)
      },
    })
    entry = {
      connection,
      // Handshake once per process, not once per conversation.
      initialize: connection.agent.initialize({
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
      refCount: 0,
    }
    connections.set(key, entry)
  } else {
    logger.info(
      `Reusing ${options.providerId} ACP agent for conversation #${entry.refCount + 1}`,
    )
  }

  const held = entry
  held.refCount += 1
  let released = false
  const release = () => {
    if (released) return
    released = true
    held.refCount -= 1
    if (held.refCount > 0) return
    if (connections.get(key) === held) connections.delete(key)
    void held.connection.dispose()
  }

  try {
    const initialize = await held.initialize
    return { connection: held.connection, initialize, release }
  } catch (error) {
    // A failed handshake leaves nothing worth sharing.
    release()
    throw error
  }
}

/** Test seam — drops every connection without waiting for its holders. */
export function disposeAllAcpConnections(): void {
  for (const [key, entry] of connections) {
    connections.delete(key)
    void entry.connection.dispose()
  }
}
