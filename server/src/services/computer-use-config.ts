/**
 * Computer Use master switch.
 *
 * Mirrors `browser-use-config.ts`, but the two features are *not* symmetric under the
 * hood — see the gate in `mcp-config.ts`. `node_repl` is a single MCP server whose one
 * `js` tool exposes both `computer.*` (Computer Use) and `agent.browsers` (Browser Use), so
 * this switch cannot inject or withhold an MCP server of its own. What it owns is:
 *
 *   1. the `operon-computer-use` skill file, and
 *   2. whether the cua-driver daemon starts at all — no daemon, no `computer.*`.
 *
 * `node_repl` itself is mounted when *either* feature is on.
 */
import type { StorageAdapter } from '../storage/interface.js'

const CONFIG_KEY = 'computer-use-config'

/**
 * Approvals that cross every app boundary, so no app approval covers them.
 * The ids are the `capability` the computer-use package asks with.
 */
export const COMPUTER_USE_CAPABILITIES = ['desktop-capture', 'clipboard-read', 'clipboard-write'] as const
export type ComputerUseCapability = typeof COMPUTER_USE_CAPABILITIES[number]

export interface ComputerUseConfig {
  enabled: boolean
  /** Bundle identifiers explicitly approved with "Always allow". */
  approvedApps: string[]
  /** Bundle identifiers the user blocked in Settings. Beats every approval. */
  blockedApps: string[]
  /** Cross-app capabilities approved with "Always allow". */
  approvedCapabilities: ComputerUseCapability[]
}

/** Off until asked for: it lets agents drive the user's real Mac UI. */
const DEFAULT_CONFIG: ComputerUseConfig = {
  enabled: false,
  approvedApps: [],
  blockedApps: [],
  approvedCapabilities: [],
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : []

export function isComputerUseCapability(value: unknown): value is ComputerUseCapability {
  return typeof value === 'string' && (COMPUTER_USE_CAPABILITIES as readonly string[]).includes(value)
}

let kvStore: StorageAdapter | null = null

export function initComputerUseConfig(storage: StorageAdapter): void {
  kvStore = storage
}

export function getComputerUseConfig(): ComputerUseConfig {
  if (!kvStore) return { ...DEFAULT_CONFIG }
  const stored = kvStore.get<Partial<ComputerUseConfig>>(CONFIG_KEY)
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    approvedApps: stringList(stored?.approvedApps),
    blockedApps: stringList(stored?.blockedApps),
    approvedCapabilities: stringList(stored?.approvedCapabilities).filter(isComputerUseCapability),
  }
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

function listHas(list: readonly string[], app: string): boolean {
  const normalized = normalizeAppIdentifier(app)
  return normalized !== '' && list.some((item) => normalizeAppIdentifier(item) === normalized)
}

function without(list: readonly string[], app: string): string[] {
  const normalized = normalizeAppIdentifier(app)
  return list.filter((item) => normalizeAppIdentifier(item) !== normalized)
}

export function isComputerUseAppAlwaysApproved(app: string): boolean {
  return listHas(getComputerUseConfig().approvedApps, app)
}

export function isComputerUseAppBlocked(app: string): boolean {
  return listHas(getComputerUseConfig().blockedApps, app)
}

/** Remember an "Always allow". A blocked app stays blocked: the block is the
 *  user's standing decision, the approval only a moment's. */
export function alwaysApproveComputerUseApp(app: string): void {
  const trimmed = app.trim()
  if (!trimmed || isComputerUseAppAlwaysApproved(trimmed) || isComputerUseAppBlocked(trimmed)) return
  const config = getComputerUseConfig()
  updateComputerUseConfig({ approvedApps: [...config.approvedApps, trimmed] })
}

/**
 * Set an app's standing rule from Settings. The two lists are exclusive, so
 * either rule removes the app from the other list; `null` removes both.
 */
export function setComputerUseAppRule(app: string, rule: 'allow' | 'block' | null): ComputerUseConfig {
  const trimmed = app.trim()
  if (!trimmed) throw new Error('app must be a non-empty bundle identifier')
  const config = getComputerUseConfig()
  const approvedApps = without(config.approvedApps, trimmed)
  const blockedApps = without(config.blockedApps, trimmed)
  if (rule === 'allow') approvedApps.push(trimmed)
  if (rule === 'block') blockedApps.push(trimmed)
  return updateComputerUseConfig({ approvedApps, blockedApps })
}

export function isComputerUseCapabilityAlwaysApproved(capability: ComputerUseCapability): boolean {
  return getComputerUseConfig().approvedCapabilities.includes(capability)
}

export function setComputerUseCapabilityApproved(capability: ComputerUseCapability, approved: boolean): ComputerUseConfig {
  const rest = getComputerUseConfig().approvedCapabilities.filter((item) => item !== capability)
  return updateComputerUseConfig({ approvedCapabilities: approved ? [...rest, capability] : rest })
}
