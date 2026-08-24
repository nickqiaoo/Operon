/**
 * Browser Use master switch.
 *
 * Gates the two ways Browser Use reaches an agent:
 *
 *   1. the `node_repl` MCP server (`mcp-config.ts`) — recomputed per session, so
 *      flipping this only affects sessions started afterwards. Note this switch does
 *      not *own* node_repl: the same server also hosts Computer Use's `computer.*`, so it
 *      is mounted when either feature is on (see the gate for the full reasoning);
 *   2. the `operon-browser-use` skill (`browser-use-skill.ts`) — a *file* under
 *      `~/.agents/skills`, `~/.grok/skills`, and `~/.claude/skills`, so turning
 *      the switch off has to delete it. Skipping the install is not enough:
 *      agents scan those directories themselves and would keep finding a stale copy.
 *
 * Stored in the same KV the other settings use (mirrors `embedding-provider-config`,
 * which gates the `memory` MCP the same way). Deliberately *not* stored in
 * `~/.operon/browser/config.toml`: that file is codex's own schema, written by the
 * vendored browser-client, and is read asynchronously — `buildMcpServersForCli` is
 * synchronous and cannot await it.
 */
import type { StorageAdapter } from '../storage/interface.js'

const CONFIG_KEY = 'browser-use-config'

export interface BrowserUseConfig {
  enabled: boolean
}

/** Off until asked for: it hands every agent a browser and writes to the user's skill dirs. */
const DEFAULT_CONFIG: BrowserUseConfig = {
  enabled: false,
}

let kvStore: StorageAdapter | null = null

export function initBrowserUseConfig(storage: StorageAdapter): void {
  kvStore = storage
}

export function getBrowserUseConfig(): BrowserUseConfig {
  if (!kvStore) return { ...DEFAULT_CONFIG }
  const stored = kvStore.get<Partial<BrowserUseConfig>>(CONFIG_KEY)
  return { ...DEFAULT_CONFIG, ...stored }
}

export function updateBrowserUseConfig(config: Partial<BrowserUseConfig>): BrowserUseConfig {
  if (!kvStore) throw new Error('Browser Use config not initialized')
  const updated = { ...getBrowserUseConfig(), ...config }
  kvStore.set(CONFIG_KEY, updated)
  return updated
}
