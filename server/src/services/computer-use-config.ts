/**
 * Computer Use master switch.
 *
 * Mirrors `browser-use-config.ts`, but the two features are *not* symmetric under the
 * hood — see the gate in `mcp-config.ts`. `node_repl` is a single MCP server whose one
 * `js` tool exposes both `computer.*` (Computer Use) and `agent.browsers` (Browser Use), so
 * this switch cannot inject or withhold an MCP server of its own. What it owns is:
 *
 *   1. the `operon-computer-use` skill file, and
 *   2. whether the native Swift service starts at all — no service, no `computer.*`.
 *
 * `node_repl` itself is mounted when *either* feature is on.
 */
import type { StorageAdapter } from '../storage/interface.js'

const CONFIG_KEY = 'computer-use-config'

/**
 * Which native engine backs `computer.*`.
 *
 * `swift` is the in-tree OpenComputerUseKit service; `cua-driver` is the Rust
 * daemon from trycua/cua, which additionally renders the animated agent-cursor
 * overlay. The kernel picks its backend from an env var baked in at fork time,
 * so switching this restarts the shared kernel — see `node-repl-mcp.ts`.
 */
export type ComputerUseEngine = 'swift' | 'cua-driver'

export interface ComputerUseConfig {
  enabled: boolean
  engine: ComputerUseEngine
  /** Bundle identifiers explicitly approved with "Always allow". */
  approvedApps: string[]
}

/** Off until asked for: it lets agents drive the user's real Mac UI. */
const DEFAULT_CONFIG: ComputerUseConfig = {
  enabled: false,
  engine: 'swift',
  approvedApps: [],
}

let kvStore: StorageAdapter | null = null

export function initComputerUseConfig(storage: StorageAdapter): void {
  kvStore = storage
}

export function getComputerUseConfig(): ComputerUseConfig {
  if (!kvStore) return { ...DEFAULT_CONFIG }
  const stored = kvStore.get<Partial<ComputerUseConfig>>(CONFIG_KEY)
  const approvedApps = Array.isArray(stored?.approvedApps)
    ? stored.approvedApps.filter((app): app is string => typeof app === 'string' && app.trim() !== '')
    : []
  const engine: ComputerUseEngine = stored?.engine === 'cua-driver' ? 'cua-driver' : 'swift'
  return { ...DEFAULT_CONFIG, ...stored, engine, approvedApps }
}

export function updateComputerUseConfig(config: Partial<ComputerUseConfig>): ComputerUseConfig {
  if (!kvStore) throw new Error('Computer Use config not initialized')
  const updated = { ...getComputerUseConfig(), ...config }
  kvStore.set(CONFIG_KEY, updated)
  return updated
}

function normalizeAppIdentifier(app: string): string {
  return app.trim().toLowerCase()
}

export function isComputerUseAppAlwaysApproved(app: string): boolean {
  const normalized = normalizeAppIdentifier(app)
  return normalized !== '' && getComputerUseConfig().approvedApps.some(
    (approved) => normalizeAppIdentifier(approved) === normalized,
  )
}

export function alwaysApproveComputerUseApp(app: string): void {
  const trimmed = app.trim()
  if (!trimmed || isComputerUseAppAlwaysApproved(trimmed)) return
  const config = getComputerUseConfig()
  updateComputerUseConfig({ approvedApps: [...config.approvedApps, trimmed] })
}
