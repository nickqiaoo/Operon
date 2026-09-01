/**
 * Shared Copilot runtime processes.
 *
 * `CopilotClient` is already a multi-session host — `createSession`,
 * `resumeSession`, `listSessions`, per-session `onPermissionRequest` and
 * `onEvent` — so one client can carry every conversation instead of each chat
 * spawning its own runtime. Everything a conversation configures (model,
 * reasoning effort, MCP servers, system message, the interactive callbacks)
 * already travels with the session config, not the client.
 *
 * Only three inputs are fixed at spawn time, and they form the key: the runtime
 * path, the environment, and the working directory. `workingDirectory` is a
 * session-level field too, but the runtime resolves project config against the
 * process's own cwd, so connections stay per-workspace rather than global.
 */

import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk'

export interface AcquireCopilotOptions {
  cliPath: string
  cwd: string
  env: Record<string, string | undefined>
}

export interface CopilotLease {
  client: CopilotClient
  release: () => Promise<void>
}

interface Entry {
  client: CopilotClient
  started: Promise<void>
  refCount: number
}

const clients = new Map<string, Entry>()

function clientKey(options: AcquireCopilotOptions): string {
  return JSON.stringify([options.cliPath, options.cwd, options.env])
}

export async function acquireCopilotClient(
  options: AcquireCopilotOptions,
): Promise<CopilotLease> {
  const key = clientKey(options)
  let entry = clients.get(key)

  if (!entry) {
    const client = new CopilotClient({
      workingDirectory: options.cwd,
      // copilotRuntimeEnv keeps PATH/HOME etc. and sets ELECTRON_RUN_AS_NODE so a
      // `.js` runtime runs as plain Node inside Electron (see config.ts).
      env: options.env,
      // Unconditional on purpose — see resolveCopilotCliPath(). A spread that can
      // omit `connection` lets the SDK fall through to its bundled platform
      // package, which this build does not ship.
      connection: RuntimeConnection.forStdio({ path: options.cliPath }),
    })
    entry = { client, started: client.start(), refCount: 0 }
    clients.set(key, entry)
  }

  const held = entry
  held.refCount += 1
  let released = false
  const release = async () => {
    if (released) return
    released = true
    held.refCount -= 1
    if (held.refCount > 0) return
    if (clients.get(key) === held) clients.delete(key)
    try {
      // forceStop, not stop: a graceful stop can hang, and each session already
      // disconnected itself, so we only need the runtime process gone.
      await held.client.forceStop()
    } catch {
      // Already gone — nothing left to clean up.
    }
  }

  try {
    await held.started
    return { client: held.client, release }
  } catch (error) {
    // A runtime that never started is not worth sharing.
    await release()
    throw error
  }
}

/** Test seam — drops every client without waiting for its holders. */
export async function disposeAllCopilotClients(): Promise<void> {
  const entries = [...clients.values()]
  clients.clear()
  await Promise.all(entries.map((entry) => entry.client.forceStop().catch(() => {})))
}
