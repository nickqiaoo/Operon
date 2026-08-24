import type { StorageAdapter } from '../storage/interface.js'

const KV_KEY = 'system:env_vars'

let _storage: StorageAdapter | null = null
// Track which keys we previously injected so we can clean up stale ones
let _appliedKeys: string[] = []

export function initEnvConfigService(storage: StorageAdapter): void {
  _storage = storage
  // Apply persisted env vars to process.env immediately on startup
  applyEnvVarsToProcess(getEnvVars())
}

export function getEnvVars(): Record<string, string> {
  if (!_storage) return {}
  return _storage.get<Record<string, string>>(KV_KEY) ?? {}
}

export function setEnvVars(vars: Record<string, string>): void {
  if (!_storage) return
  _storage.set(KV_KEY, vars)
  applyEnvVarsToProcess(vars)
}

/**
 * Apply user-configured env vars to process.env so that all adapters
 * (Codex, OpenCode, AiSdk, etc.) and any child processes they spawn
 * can inherit them automatically.
 *
 * Previously injected keys that are no longer present are removed
 * so stale values don't linger.
 */
function applyEnvVarsToProcess(vars: Record<string, string>): void {
  // Remove keys that were set before but are now gone
  for (const key of _appliedKeys) {
    if (!(key in vars)) {
      delete process.env[key]
    }
  }
  // Apply current vars
  for (const [key, value] of Object.entries(vars)) {
    if (key.trim()) {
      process.env[key] = value
    }
  }
  _appliedKeys = Object.keys(vars).filter((k) => k.trim())
}
