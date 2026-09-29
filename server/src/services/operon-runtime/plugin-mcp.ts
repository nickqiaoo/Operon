import type { McpServerEntry } from '../mcp-config.js'
import type { PluginMcpServerExport } from './codex-plugin-apps.js'
import { hasMcpTokens } from './mcp-oauth.js'
import { pluginManager } from './plugins.js'

/**
 * Plugin MCP servers as other agents (Claude Code, Codex, OpenCode…) mount them.
 *
 * Computed live from the plugin manager on every session build — nothing is written to
 * `mcp-servers.json`, because the enable/disable state already lives in the plugin store and a
 * second copy would only drift. Operon itself does not use this: its harness reads the plugin
 * manager directly (and handles OAuth itself).
 */
export type PluginMcpMount =
  | (MountBase & { kind: 'direct'; entry: McpServerEntry })
  | (MountBase & { kind: 'gateway'; reason: GatewayReason })
  | (MountBase & { kind: 'skip'; reason: string })

interface MountBase {
  /** The server name other agents see. */
  name: string
  pluginId: string
  pluginName: string
  server: string
  /** Operon's internal name, `plugin-<id>:<server>` — the OAuth token-store key. */
  runtimeName: string
  transport: 'stdio' | 'http'
}

type GatewayReason = 'oauth' | 'tool-filter' | 'cwd'

/**
 * `plugin-<id>:<server>` → `plugin_<id>_<server>`. The colon is not legal in Claude tool names
 * (`mcp__<server>__<tool>`), and hyphens are out too: some clients treat `-` as the server↔tool
 * separator and silently drop the tools (the rule every first-party server here follows).
 */
export function pluginMcpMountName(runtimeName: string): string {
  return runtimeName.replace(/[^A-Za-z0-9_]/g, '_')
}

/** Requires the plugin store to be loaded (`ensurePluginsLoaded`); before that it is empty. */
export function listPluginMcpMounts(): PluginMcpMount[] {
  return pluginManager.mcpServerExports(hasMcpTokens).map(toMount)
}

/** The gateway-routed server a `/api/mcp-gateway/<name>` request refers to, if it still is one. */
export function findGatewayServer(name: string): PluginMcpServerExport | undefined {
  return pluginManager
    .mcpServerExports(hasMcpTokens)
    .find((server) => pluginMcpMountName(server.runtimeName) === name && gatewayReason(server) !== undefined)
}

function toMount(server: PluginMcpServerExport): PluginMcpMount {
  const { config } = server
  const base: MountBase = {
    name: pluginMcpMountName(server.runtimeName),
    pluginId: server.pluginId,
    pluginName: server.pluginName,
    server: server.server,
    runtimeName: server.runtimeName,
    transport: config.transport,
  }
  const reason = gatewayReason(server)
  if (reason !== undefined) return { ...base, kind: 'gateway', reason }

  if (config.transport === 'stdio') {
    if (config.command === undefined) return { ...base, kind: 'skip', reason: 'stdio server has no command' }
    return {
      ...base,
      kind: 'direct',
      entry: {
        command: config.command,
        ...(config.args !== undefined ? { args: [...config.args] } : {}),
        ...(config.env !== undefined ? { env: { ...config.env } } : {}),
      },
    }
  }

  if (config.url === undefined) return { ...base, kind: 'skip', reason: 'http server has no url' }
  const headers: Record<string, string> = { ...(config.headers ?? {}) }
  // Resolved here, in Operon's environment: the agent CLI may not inherit the same variables.
  const bearer = config.bearerTokenEnvVar !== undefined ? process.env[config.bearerTokenEnvVar] : undefined
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`
  return {
    ...base,
    kind: 'direct',
    entry: { type: 'http', url: config.url, ...(Object.keys(headers).length > 0 ? { headers } : {}) },
  }
}

/**
 * Why a server has to go through Operon's gateway instead of being handed out as-is:
 * - `oauth`: the token must stay inside Operon (one login shared by every agent);
 * - `tool-filter`: agent CLIs have no portable way to express allowed/blocked tools;
 * - `cwd`: agent CLI MCP configs have no portable working directory.
 */
function gatewayReason(server: PluginMcpServerExport): GatewayReason | undefined {
  if (server.requiresOAuth) return 'oauth'
  if (server.config.allowedTools !== undefined || server.config.blockedTools !== undefined) return 'tool-filter'
  if (server.config.transport === 'stdio' && server.config.cwd !== undefined) return 'cwd'
  return undefined
}
