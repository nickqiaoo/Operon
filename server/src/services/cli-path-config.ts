import type { StorageAdapter } from '../storage/interface.js'

const KV_KEY = 'cli:path_configs'

// Adapters that shell out to a binary the user installs themselves. Being on
// this list is what makes an adapter's availability actually *checked* — and
// what lets the user point at a non-standard install path in Settings.
export const CLI_ADAPTER_IDS = [
  'claude-code',
  'codex',
  'opencode',
  'kimi',
  'grok',
  'cursor',
  'copilot',
] as const

export type CliAdapterId = (typeof CLI_ADAPTER_IDS)[number]

export type CliPathConfigs = Partial<Record<CliAdapterId, string>>

let _storage: StorageAdapter | null = null

export function initCliPathConfigService(storage: StorageAdapter): void {
  _storage = storage
}

export function isCliAdapterId(value: string): value is CliAdapterId {
  return CLI_ADAPTER_IDS.includes(value as CliAdapterId)
}

export function getCliPathConfigs(): CliPathConfigs {
  if (!_storage) return {}
  return _storage.get<CliPathConfigs>(KV_KEY) ?? {}
}

export function getCliPathConfig(adapterId: CliAdapterId): string | undefined {
  return getCliPathConfigs()[adapterId]
}

export function setCliPathConfig(adapterId: CliAdapterId, path: string | undefined): void {
  if (!_storage) return
  const all = getCliPathConfigs()
  if (path) {
    all[adapterId] = path
  } else {
    delete all[adapterId]
  }
  _storage.set(KV_KEY, all)
}
