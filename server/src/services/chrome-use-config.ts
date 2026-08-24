/**
 * Chrome Browser Use master switch.
 *
 * Gates three things, and unlike the other two features one of them reaches outside the app:
 *
 *   1. the `node_repl` MCP server (`mcp-config.ts`) — the browser client runs inside that
 *      kernel, same as the in-app browser, so Chrome joins the OR that mounts it;
 *   2. the `operon-chrome` skill (`chrome-use-skill.ts`) — a *file* under
 *      `~/.agents/skills`, `~/.grok/skills`, and `~/.claude/skills`, so turning
 *      the switch off has to delete it;
 *   3. the **native messaging host** — a wrapper script plus a manifest inside Chrome's own
 *      config directory. This is the one that outlives us: leaving it behind means Chrome
 *      keeps a registered way to launch operon after the user said no.
 *
 * Separate from `browser-use-config` on purpose. They are two backends behind one client, but
 * they are not one feature: the in-app browser is our own sandbox, while this drives the
 * user's real Chrome with their logins. Consenting to one is not consenting to the other.
 *
 * Stored in the same KV as the rest (mirrors `embedding-provider-config`, which gates the
 * `memory` MCP the same way). Sync because `buildMcpServersForCli` is sync and cannot await.
 */
import type { StorageAdapter } from '../storage/interface.js'

const CONFIG_KEY = 'chrome-use-config'

export interface ChromeUseConfig {
  enabled: boolean
}

/** Off until asked for: it reaches into the user's real browser and writes to their disk. */
const DEFAULT_CONFIG: ChromeUseConfig = {
  enabled: false,
}

let kvStore: StorageAdapter | null = null

export function initChromeUseConfig(storage: StorageAdapter): void {
  kvStore = storage
}

export function getChromeUseConfig(): ChromeUseConfig {
  if (!kvStore) return { ...DEFAULT_CONFIG }
  const stored = kvStore.get<Partial<ChromeUseConfig>>(CONFIG_KEY)
  return { ...DEFAULT_CONFIG, ...stored }
}

export function updateChromeUseConfig(config: Partial<ChromeUseConfig>): ChromeUseConfig {
  if (!kvStore) throw new Error('Chrome Use config not initialized')
  const updated = { ...getChromeUseConfig(), ...config }
  kvStore.set(CONFIG_KEY, updated)
  return updated
}
