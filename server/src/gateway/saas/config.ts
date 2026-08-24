import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

// Persisted SaaS connection state, shared with the tunnel agent (which reads the
// same file to find its node token). Lives next to plugin-server.json.
//
// Deliberately does NOT hold the broker URL: that is compiled in (see broker.ts)
// so that a build upgrade moves the machine, instead of leaving it pinned to
// whichever broker it happened to sign in to first.
export interface SaasConfig {
  accessToken?: string
  userId?: string
  nodeId?: string
  nodeToken?: string
  label?: string
  connectedAt?: number
}

const FILE = join(homedir(), '.operon', 'saas.json')

export function getSaasConfig(): SaasConfig {
  try {
    return JSON.parse(readFileSync(FILE, 'utf-8')) as SaasConfig
  } catch {
    return {}
  }
}

export function setSaasConfig(patch: Partial<SaasConfig>): SaasConfig {
  const next = { ...getSaasConfig(), ...patch }
  mkdirSync(dirname(FILE), { recursive: true })
  // Holds the SaaS access token and node token — owner-only. writeFileSync's
  // mode only applies on create, so also tighten a pre-existing 644 file.
  writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 })
  chmodSync(FILE, 0o600)
  return next
}

export function clearSaasConfig(): void {
  try {
    rmSync(FILE)
  } catch {
    // already gone
  }
}
