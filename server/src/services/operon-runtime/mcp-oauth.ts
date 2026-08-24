import { McpOAuthService } from 'operon-agents'
import { HARNESS_HOME_DIR } from './paths.js'

/**
 * One shared MCP OAuth service for the whole app. Tokens live under `HARNESS_HOME_DIR` (a
 * `JsonFileStore` on disk), which is the SAME store the chat harness reads — so a login completed
 * from the Plugins UI is immediately usable by chat sessions (connect once, chat just works).
 *
 * The store key is derived from `(serverName, url)`; callers MUST pass the plugin MCP server's
 * runtime name (`plugin-<id>:<server>`, from `PluginMcpServerInfo.runtimeName`) so the key matches
 * what the harness uses when it connects that server.
 */
export const mcpOAuthService = new McpOAuthService({ homeDir: HARNESS_HOME_DIR, clientLabel: 'operon' })

// In-flight browser-auth flows, keyed by `${pluginId}::${server}` so status polling can show "waiting".
interface PendingFlow {
  status: 'pending' | 'done' | 'error'
  error?: string
  cancel: () => Promise<void>
}
const pending = new Map<string, PendingFlow>()
const flowKey = (pluginId: string, server: string) => `${pluginId}::${server}`

export function hasMcpTokens(runtimeName: string, url: string): boolean {
  try {
    return mcpOAuthService.hasTokens(runtimeName, url)
  } catch {
    return false
  }
}

export function mcpAuthPending(pluginId: string, server: string): boolean {
  return pending.get(flowKey(pluginId, server))?.status === 'pending'
}

export interface BeginMcpAuthResult {
  /** The provider authorization URL to open in a browser. Absent when already authorized. */
  authorizationUrl?: string
  alreadyAuthorized: boolean
}

/**
 * Start the OAuth flow for one plugin MCP server. Returns the authorization URL (the caller opens it
 * in the browser); the framework's local callback server catches the redirect. Completion is awaited
 * in the background so the request returns immediately — the UI polls `hasMcpTokens` via status.
 */
export async function beginMcpAuth(
  pluginId: string,
  server: string,
  runtimeName: string,
  url: string,
): Promise<BeginMcpAuthResult> {
  const key = flowKey(pluginId, server)
  const existing = pending.get(key)
  if (existing && existing.status === 'pending') {
    try {
      await existing.cancel()
    } catch {
      // best-effort — a stale flow being cancelled shouldn't block a fresh one
    }
  }

  try {
    const flow = await mcpOAuthService.beginAuthorization(runtimeName, url)
    const state: PendingFlow = { status: 'pending', cancel: () => flow.cancel() }
    pending.set(key, state)
    flow
      .complete()
      .then(() => {
        state.status = 'done'
      })
      .catch((error) => {
        state.status = 'error'
        state.error = error instanceof Error ? error.message : String(error)
      })
    return { authorizationUrl: flow.authorizationUrl.toString(), alreadyAuthorized: false }
  } catch (error) {
    // `beginAuthorization` throws AlreadyAuthorizedError when valid tokens already exist (e.g. an
    // unexpired refresh) — no browser flow needed.
    if (error instanceof Error && error.name === 'AlreadyAuthorizedError') {
      pending.delete(key)
      return { alreadyAuthorized: true }
    }
    throw error
  }
}

export async function cancelMcpAuth(pluginId: string, server: string): Promise<void> {
  const key = flowKey(pluginId, server)
  const state = pending.get(key)
  if (state) {
    try {
      await state.cancel()
    } catch {
      // best-effort
    }
    pending.delete(key)
  }
}

/** Forget stored credentials for a plugin MCP server (client registration, tokens, discovery). */
export function disconnectMcp(runtimeName: string, url: string): void {
  mcpOAuthService.getProvider(runtimeName, url).invalidateCredentials('all')
}
