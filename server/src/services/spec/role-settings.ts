/**
 * Settings → OperonSpec: who plays each role in a new spec, kept in the app's
 * key-value store. A role left unset is picked automatically (`defaultSpecConfig`).
 */

import type { StorageAdapter } from '../../storage/interface.js'
import type { SpecRoleSettings, SpecSeat } from '../../types/spec.js'

const KV_ROLES = 'spec:roles'

let _storage: Pick<StorageAdapter, 'get' | 'set'> | null = null

export function initSpecRoleSettings(storage: Pick<StorageAdapter, 'get' | 'set'>): void {
  _storage = storage
}

function cleanSeat(value: unknown): SpecSeat | null {
  if (!value || typeof value !== 'object') return null
  const { providerId, modelId } = value as { providerId?: unknown; modelId?: unknown }
  if (typeof providerId !== 'string' || !providerId.trim()) return null
  return typeof modelId === 'string' && modelId.trim()
    ? { providerId: providerId.trim(), modelId: modelId.trim() }
    : { providerId: providerId.trim() }
}

/** Keep only well-formed seats; anything else reads as "automatic". */
export function cleanRoleSettings(value: unknown): SpecRoleSettings {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const out: SpecRoleSettings = {}
  for (const role of ['lead', 'explorer', 'judge', 'builder', 'implementer', 'reviewer', 'coordinator'] as const) {
    const seat = cleanSeat(raw[role])
    if (seat) out[role] = seat
  }
  const candidates = Array.isArray(raw.candidates) ? raw.candidates.map(cleanSeat).filter((s): s is SpecSeat => s != null) : []
  if (candidates.length > 0) out.candidates = candidates
  return out
}

export function getSpecRoleSettings(): SpecRoleSettings {
  return cleanRoleSettings(_storage?.get<unknown>(KV_ROLES))
}

export function setSpecRoleSettings(value: unknown): SpecRoleSettings {
  const settings = cleanRoleSettings(value)
  _storage?.set(KV_ROLES, settings)
  return settings
}

/**
 * The providers usable on this machine, as the app knows them. Set at startup,
 * so the spec services do not pull the provider runtime in (or into their tests).
 */
let providerSource: () => string[] = () => []

export function setUsableProviderSource(source: () => string[]): void {
  providerSource = source
}

export function usableProviders(): string[] {
  return providerSource()
}
