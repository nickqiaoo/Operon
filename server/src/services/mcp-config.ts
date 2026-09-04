import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { getEmbeddingConfig } from './vector/embeddings.js'
import { getBrowserUseConfig } from './browser-use-config.js'
import { getComputerUseConfig } from './computer-use-config.js'
import { getChromeUseConfig } from './chrome-use-config.js'
import type { AgentMcpContext } from './ai/types.js'
import { getApiToken, isApiTokenAuthDisabled } from './api-token.js'

const DATA_DIR = process.env.OPERON_DATA_DIR || path.join(os.homedir(), '.operon', 'data')
const MCP_CONFIG_PATH = path.join(DATA_DIR, 'mcp-servers.json')

export type McpStdioConfig = {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
}

export type McpHttpConfig = {
  type: 'http'
  url: string
  headers?: Record<string, string>
}

export type McpSseConfig = {
  type: 'sse'
  url: string
  headers?: Record<string, string>
}

export type McpServerEntry = McpStdioConfig | McpHttpConfig | McpSseConfig

export type McpServersConfig = Record<string, McpServerEntry>

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

export function getMcpServers(): McpServersConfig {
  try {
    ensureDataDir()
    if (!fs.existsSync(MCP_CONFIG_PATH)) return {}
    const raw = fs.readFileSync(MCP_CONFIG_PATH, 'utf-8')
    return JSON.parse(raw) as McpServersConfig
  } catch {
    return {}
  }
}

export function saveMcpServers(servers: McpServersConfig): void {
  ensureDataDir()
  // User-configured servers may carry auth headers — owner-only. The mode only
  // applies on create, so also tighten a pre-existing file.
  fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(servers, null, 2), { encoding: 'utf-8', mode: 0o600 })
  fs.chmodSync(MCP_CONFIG_PATH, 0o600)
}

// The MCP-mount context is defined once as AgentMcpContext (ai/types) and shared:
// the chat request carries it and forwards it here verbatim.
export type BuildMcpOptions = AgentMcpContext

// First-party loopback MCP servers must present the startup token like every
// other /api caller. It rides the URL query, NOT a `headers` field, for the
// same reason agent identity does (see below): some MCP clients silently drop
// server entries whose config carries fields they don't recognize.
function withApiToken(url: string): string {
  if (isApiTokenAuthDisabled()) return url
  return `${url}${url.includes('?') ? '&' : '?'}token=${getApiToken()}`
}

function formatMcpServerTarget(entry: McpServerEntry): string {
  if ('command' in entry) {
    const args = entry.args?.length ? ` ${entry.args.join(' ')}` : ''
    return `stdio:${entry.command}${args}`
  }

  // The token is a credential; keep it out of the startup log.
  return `${entry.type}:${entry.url.replace(/([?&]token=)[^&]+/, '$1***')}`
}

/**
 * Build full MCP servers config for a CLI adapter.
 * Merges user-configured servers + memory + external_agent.
 * Pass agentId (+ projectId for workspace/task-board; or imBridge: true for
 * IM) to also inject first-party agent communication MCP servers.
 */
export function buildMcpServersForCli(
  providerId: string,
  options?: BuildMcpOptions,
  /** Runtime provider id of the caller (`custom`, `claude-code`, …), as opposed to
   *  the CLI name `providerId` carries. Only external_agent needs it, to leave the
   *  caller out of its own delegation list. */
  callerProviderId?: string,
): McpServersConfig | undefined {
  const servers = getMcpServers()
  const appPort = process.env.OPERON_PORT ?? '3100'

  // Drop legacy first-party names even if they exist in the persisted config.
  // The old bridge names point at removed routes; task_board was superseded by
  // taskboard and would otherwise register the same endpoint twice.
  delete servers['chat_bridge']
  delete servers['im_bridge']
  delete servers['inbox']
  delete servers['task_board']

  if (getEmbeddingConfig()?.enabled) {
    servers['memory'] = {
      type: 'http',
      url: withApiToken(`http://127.0.0.1:${appPort}/api/memory-mcp`),
    }
  }

  // node_repl backs Computer Use and Browser Use: the model runs JS inside it to
  // drive the browser and the desktop.
  //
  // The sessionId is baked into the URL. The kernel keeps `globalThis` alive
  // across turns, which is how `agent.browsers` gets reused, so two conversations
  // sharing one JavaScript world would see each other's variables. The route
  // therefore gives each sessionId its own vm context (inside a kernel process
  // shared by all of them).
  // This is also why identity does not come from per-request metadata: a
  // statically configured kernel is spawned identically for every session and can
  // only be told who it is on each request. Operon computes mcpServers per session
  // in the host, so identity can be baked in at mount time. A client that does
  // send `_meta` still wins; for the rest the route synthesises it from the URL.
  //
  // Gated by the three master switches in Settings, the same shape as memory
  // being gated on embedding config above.
  //
  // Note this is an OR, not one MCP per feature. node_repl is a single server
  // exposing a single `js` tool, and Computer Use (`computer.*`), Browser Use and
  // Chrome (both `agent.browsers`, differing only in backend) all live inside the
  // same kernel. There is no such thing as "the Computer Use MCP": if any one of
  // them is on, node_repl has to be mounted, or that feature's skill will tell the
  // model to call a tool that was never mounted.
  // What differs between them lives elsewhere: Browser relies on its skill plus an
  // approval policy, Chrome adds a native host (see chrome-use.ts), and Computer
  // depends on whether the Swift service starts (see node-repl-mcp.ts).
  //
  // This computes mcpServers for *new* sessions. Sessions already running had
  // theirs computed at creation, and turning a switch off does not reach back to
  // them, which is why the node-repl-mcp route checks again to catch those.
  const nodeReplEnabled =
    getBrowserUseConfig().enabled || getComputerUseConfig().enabled || getChromeUseConfig().enabled
  // Codex already owns a stdio `node_repl` in its user config. Passing any
  // same-named Operon entry can merge `command` and `url` into one invalid
  // Codex MCP config ("url is not supported for stdio").
  if (providerId === 'codex') {
    delete servers['node_repl']
  } else if (options?.chatId != null && nodeReplEnabled) {
    servers['node_repl'] = {
      type: 'http',
      url: withApiToken(`http://127.0.0.1:${appPort}/api/node-repl-mcp?sessionId=${options.chatId}`),
    }
  }

  // external_agent = "hand this off to a DIFFERENT agent", so the caller is not
  // one of the choices: delegating to yourself is just doing the work.
  //
  // Only the caller rides the URL; the route derives the list live (same reasoning
  // as `workflow` below). Baking the list in made the URL depend on
  // `isAdapterAvailable`, a live probe — one CLI appearing or timing out rewrote the
  // URL, which changed the session-reuse fingerprint and silently rebuilt the
  // session, reconnecting every MCP server with it.
  //
  // `callerProviderId` is the runtime provider id, NOT the CLI name this function is
  // otherwise keyed by. Comparing the CLI name against provider ids is why the
  // caller was never actually excluded: Operon runs as provider `custom` but CLI
  // name `operon`, so it kept listing itself as a delegation target.
  servers['external_agent'] = {
    type: 'http',
    url: withApiToken(
      `http://127.0.0.1:${appPort}/api/external-agent-mcp` +
      `?caller=${encodeURIComponent(callerProviderId ?? '')}`,
    ),
  }

  // workflow = deterministic multi-agent orchestration (OperonWorkflow tool). Always
  // injected. cwd rides the URL so sub-agent sessions spawn in this session's
  // workspace; the agent list deliberately does NOT — it is the same for every
  // caller, and baking it in here froze it at session-creation time. The route
  // reads it live instead (see workflow-mcp.ts).
  servers['workflow'] = {
    type: 'http',
    url: withApiToken(
      `http://127.0.0.1:${appPort}/api/workflow-mcp?sessionId=${options?.chatId ?? ''}` +
      `&cwd=${encodeURIComponent(options?.cwd ?? '')}`,
    ),
  }

  // Server names use underscores (not hyphens): some MCP clients / tool-name
  // regexes treat `-` as the server↔tool separator and silently drop tools
  // whose namespace contains it. Keep names in [a-zA-Z0-9_].
  //
  // Agent identity goes in the URL query string (not HTTP headers): some
  // MCP clients (notably the Python SDK used by kimi) silently drop server
  // entries that include a `headers` field they don't recognize.
  if (options?.agentId && options.imBridge) {
    servers['im_chat'] = {
      type: 'http',
      url: withApiToken(`http://127.0.0.1:${appPort}/api/im-chat-mcp?agentId=${options.agentId}`),
    }
    console.log(`[MCP] im_chat injected for agent ${options.agentId}`)
  } else if (options?.agentId && options.projectId) {
    // workspace_chat = agent-to-agent messaging within the project. Only for
    // channel/binding agents; a direct user chat (sourceChatId) is solo and has
    // no peers to message, so it gets taskboard (SDD) but not workspace_chat.
    if (!options.sourceChatId) {
      servers['workspace_chat'] = {
        type: 'http',
        url: withApiToken(`http://127.0.0.1:${appPort}/api/workspace-chat-mcp?agentId=${options.agentId}&projectId=${options.projectId}`),
      }
    }
    servers['taskboard'] = {
      type: 'http',
      url: withApiToken(
        `http://127.0.0.1:${appPort}/api/task-board-mcp?agentId=${options.agentId}&projectId=${options.projectId}` +
        // SDD promote source — derived server-side, never model-supplied. A channel
        // agent carries channelId; a direct user chat carries sourceChatId (mutually
        // exclusive). The SDD tools are always exposed; create_spec_task is the trigger.
        (options.channelId ? `&channelId=${options.channelId}` : '') +
        (options.sourceChatId ? `&sourceChatId=${options.sourceChatId}` : ''),
      ),
    }
    console.log(
      `[MCP] ${options.sourceChatId ? 'taskboard' : 'workspace_chat/taskboard'} injected for agent ${options.agentId} project ${options.projectId}`,
    )
  }

  // Team inbox: agent-to-agent point-to-point. Independent from workspace chat,
  // task board, and IM chat; scope is resolved from the binding session id.
  if (options?.agentId && options.inboxAgentSessionId) {
    servers['team_inbox'] = {
      type: 'http',
      url: withApiToken(
        `http://127.0.0.1:${appPort}/api/team-inbox-mcp` +
        `?agentId=${options.agentId}` +
        `&agentSessionId=${encodeURIComponent(options.inboxAgentSessionId)}`,
      ),
    }
    console.log(
      `[MCP] team_inbox injected for agent ${options.agentId} (session ${options.inboxAgentSessionId})`,
    )
  }

  const serverEntries = Object.entries(servers)
  if (serverEntries.length > 0) {
    console.log(`[MCP] buildMcpServersForCli(${providerId}) OPERON_PORT=${appPort}`)
    for (const [name, entry] of serverEntries) {
      console.log(`[MCP] ${providerId}.${name} => ${formatMcpServerTarget(entry)}`)
    }
  }
  return serverEntries.length > 0 ? servers : undefined
}

/**
 * Runtime provider id → the adapter name buildMcpServersForCli expects. Every
 * real provider whose runtime accepts MCP receives the same first-party servers.
 * Fake intentionally stays out: its deterministic scripts do not run MCP tools.
 */
const MCP_CLI_NAME_BY_PROVIDER: Record<string, string> = {
  'claude-code': 'claude-code',
  codex: 'codex',
  gemini: 'gemini',
  kimi: 'kimi',
  opencode: 'opencode',
  cursor: 'cursor',
  grok: 'grok',
  copilot: 'copilot',
  custom: 'operon',
}

/**
 * Host-side entry point: resolve the MCP servers a session should expose, keyed
 * by runtime provider id. Returns undefined for providers that opt out of MCP
 * injection, preserving their previous no-MCP behavior.
 */
export function resolveMcpServersForSession(
  providerId: string,
  options?: BuildMcpOptions,
): McpServersConfig | undefined {
  const cliName = MCP_CLI_NAME_BY_PROVIDER[providerId]
  if (!cliName) return undefined
  return buildMcpServersForCli(cliName, options, providerId)
}
