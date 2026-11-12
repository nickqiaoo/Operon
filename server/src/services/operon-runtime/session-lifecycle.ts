import { SessionAlreadyLoadedError, SessionAlreadyLoadingError, type Harness, type HarnessSession, type McpServerConfig, type SessionConfig } from 'operon-agents'
import { observeSession } from './passive-observer.js'

export type SessionPermissionConfig = NonNullable<SessionConfig['permission']>
export type SessionLimitsConfig = NonNullable<SessionConfig['limits']>

/** What a workspace contributes to a session's setup: its private MCP servers, config.toml policy and limits. */
export interface WorkspaceSessionSetup {
  readonly servers: Record<string, McpServerConfig>
  readonly permission: SessionPermissionConfig
  readonly limits: SessionLimitsConfig
}

/**
 * The `SessionConfig` a workspace setup describes.
 *
 * `mcp.servers` holds only the session's OWN servers (the conversation-scoped ones the host
 * injects). The workspace `mcp.json` servers and the plugins' are added by the harness's
 * `sessionCapabilities` factory on every open, borrowed from the project's shared pool, so they
 * are never frozen into a session's stored setup (nor their secrets written next to it).
 *
 * `permission.mode` is deliberately left out: a create sets it right after with
 * `setPermissionMode`, and on a restore an explicit mode would beat the one the session last ran in.
 */
export function workspaceSessionConfig(setup: WorkspaceSessionSetup, instructions?: string): SessionConfig {
  return {
    mcp: { servers: setup.servers },
    permission: setup.permission,
    ...(Object.keys(setup.limits).length > 0 ? { limits: setup.limits } : {}),
    ...(instructions?.trim() ? { appendSystemPrompt: instructions.trim() } : {}),
  }
}

// All provider instances share restoration for the same harness/id.
const restoring = new WeakMap<Harness, Map<string, Promise<HarnessSession>>>()

/**
 * Restore `id` with the host's current setup for it, or return the instance already loaded.
 *
 * The harness joins concurrent BARE restores itself, but one given options refuses a session that
 * is loaded or still loading (`SessionAlreadyLoaded/LoadingError`) rather than apply them to it. A
 * peer delivery can be restoring the same session through `host.resumeSession(id)` at that moment;
 * joining that load is right, since the harness's `resolveSession` gives it the same setup.
 */
export function resumeRuntimeSession(
  harness: Harness,
  id: string,
  prepareConfig: () => Promise<SessionConfig>,
): Promise<HarnessSession> {
  const sessions = restoring.get(harness) ?? new Map<string, Promise<HarnessSession>>()
  restoring.set(harness, sessions)
  const pending = sessions.get(id)
  if (pending) return pending

  const task = Promise.resolve().then(async () => {
    const loaded = harness.getSession(id)
    if (loaded) return loaded
    const config = await prepareConfig()
    let session: HarnessSession
    try {
      session = await harness.resumeSession(id, { config })
    } catch (error) {
      if (!(error instanceof SessionAlreadyLoadedError || error instanceof SessionAlreadyLoadingError)) throw error
      return harness.resumeSession(id)
    }
    try {
      observeSession(session, { notifyOnTurnEnd: true })
      return session
    } catch (error) {
      await session.close()
      throw error
    }
  })
  sessions.set(id, task)
  return task.finally(() => {
    if (sessions.get(id) === task) sessions.delete(id)
  })
}
