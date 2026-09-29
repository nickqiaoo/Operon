import { serverFromConfig, type MCPTool, type MCPToolResult } from 'operon-agents/mcp'
import type { PluginMcpServerExport } from './codex-plugin-apps.js'
import { hasMcpTokens, mcpOAuthService, notifyMcpAuthChanged } from './mcp-oauth.js'

/**
 * Upstream side of the plugin MCP gateway (`/api/mcp-gateway/<name>`).
 *
 * Other agents get a loopback URL; this module holds the one real connection per plugin server,
 * authenticated with the token Operon stored when the user clicked Connect on the Plugins page.
 * One shared upstream per server, not one per agent session: the token and any stdio process are
 * owned here, and every downstream session reuses them.
 */

type Upstream = ReturnType<typeof serverFromConfig>

interface PoolEntry {
  /** The config this connection was built from; a change (plugin update) rebuilds it. */
  fingerprint: string
  server: Upstream
  connecting?: Promise<void>
}

const pool = new Map<string, PoolEntry>()

/** Thrown when the server needs a login that hasn't happened (or no longer works). */
export class GatewayNeedsAuthError extends Error {
  constructor(server: PluginMcpServerExport) {
    super(
      `${server.server} (${server.pluginName} plugin) is not connected. Sign in to it in Operon → Plugins (sidebar). ` +
      'Its tools usually appear in this conversation right after; otherwise start a new conversation.',
    )
    this.name = 'GatewayNeedsAuthError'
  }
}

export function gatewayNeedsAuth(server: PluginMcpServerExport): boolean {
  // Checked before connecting on purpose: an unauthorized connect would make the OAuth provider
  // start its own browser flow, which from a background agent session is just noise.
  return server.requiresOAuth && (server.config.url === undefined || !hasMcpTokens(server.runtimeName, server.config.url))
}

export async function gatewayListTools(server: PluginMcpServerExport): Promise<MCPTool[]> {
  const tools = await withUpstream(server, (upstream) => upstream.listTools())
  return tools.filter((tool) => toolAllowed(server, tool.name))
}

export async function gatewayCallTool(
  server: PluginMcpServerExport,
  name: string,
  args: Record<string, unknown> | null,
  signal?: AbortSignal,
): Promise<MCPToolResult> {
  if (!toolAllowed(server, name)) {
    return { content: [{ type: 'text', text: `Tool "${name}" is not available on ${server.server}.` }], isError: true }
  }
  return withUpstream(server, (upstream) => upstream.callTool(name, args, signal ? { signal } : undefined))
}

/** Close upstreams whose server is no longer routed through the gateway (plugin disabled/removed). */
export async function pruneGatewayUpstreams(active: ReadonlySet<string>): Promise<void> {
  for (const [runtimeName, entry] of pool) {
    if (active.has(runtimeName)) continue
    pool.delete(runtimeName)
    await entry.server.close().catch(() => {})
  }
}

async function withUpstream<T>(server: PluginMcpServerExport, fn: (upstream: Upstream) => Promise<T>): Promise<T> {
  if (gatewayNeedsAuth(server)) throw new GatewayNeedsAuthError(server)
  const entry = await connected(server)
  try {
    return await fn(entry.server)
  } catch (error) {
    if (!isUnauthorizedLike(error)) throw error
    // The OAuth provider already tried a refresh inside the transport; a 401 surviving that means
    // the grant is gone. Drop the connection so the next attempt after re-login starts clean.
    await drop(server.runtimeName, entry)
    signalIfGrantCleared(server)
    throw new GatewayNeedsAuthError(server)
  }
}

/**
 * A dead grant makes the MCP SDK delete the stored tokens. Tell connected agents, so they swap the
 * real tools for `connect_required`. Only when the tokens are actually gone: if they are still
 * there, re-listing would hit the same 401 and notify again, forever.
 */
function signalIfGrantCleared(server: PluginMcpServerExport): void {
  if (server.config.url !== undefined && !hasMcpTokens(server.runtimeName, server.config.url)) {
    notifyMcpAuthChanged(server.runtimeName)
  }
}

/** Forget the shared upstream so the next call connects with the current credentials. */
export async function resetGatewayUpstream(runtimeName: string): Promise<void> {
  const entry = pool.get(runtimeName)
  if (entry !== undefined) await drop(runtimeName, entry)
}

async function connected(server: PluginMcpServerExport): Promise<PoolEntry> {
  const fingerprint = JSON.stringify(server.config)
  let entry = pool.get(server.runtimeName)
  if (entry !== undefined && entry.fingerprint !== fingerprint) {
    await drop(server.runtimeName, entry)
    entry = undefined
  }
  if (entry === undefined) {
    const upstream = serverFromConfig(server.runtimeName, server.config, { oauthService: mcpOAuthService })
    const created: PoolEntry = { fingerprint, server: upstream }
    upstream.onUnexpectedClose(() => {
      if (pool.get(server.runtimeName) === created) pool.delete(server.runtimeName)
    })
    pool.set(server.runtimeName, created)
    entry = created
  }
  if (entry.server.connected) return entry

  const current = entry
  current.connecting ??= current.server.connect().finally(() => {
    current.connecting = undefined
  })
  try {
    await current.connecting
  } catch (error) {
    await drop(server.runtimeName, current)
    if (isUnauthorizedLike(error)) {
      signalIfGrantCleared(server)
      throw new GatewayNeedsAuthError(server)
    }
    throw error
  }
  return current
}

async function drop(runtimeName: string, entry: PoolEntry): Promise<void> {
  if (pool.get(runtimeName) === entry) pool.delete(runtimeName)
  await entry.server.close().catch(() => {})
}

function toolAllowed(server: PluginMcpServerExport, name: string): boolean {
  const { allowedTools, blockedTools } = server.config
  if (allowedTools !== undefined && !allowedTools.includes(name)) return false
  return !(blockedTools?.includes(name) ?? false)
}

// Same heuristic the framework's MCP manager uses to decide a server is in needs-auth.
function isUnauthorizedLike(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'UnauthorizedError') return true
  const code = (error as { code?: unknown }).code
  if (code === 401 || code === '401') return true
  return /\b401\b/.test(error.message) || /unauthorized/i.test(error.message)
}
