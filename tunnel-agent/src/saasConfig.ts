import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Written by the desktop SaaS login flow (server/src/gateway/saas/config.ts). When
// present, the agent uses it instead of env vars — so after the user logs in once,
// the agent connects with zero configuration.
//
// The broker URL is NOT here. The desktop app compiles it in (see the server's
// gateway/saas/broker.ts); a standalone agent is told where to connect with
// BROKER_URL, the same way it is told its secret.
interface SaasConfig {
  nodeToken?: string
  nodeId?: string
  label?: string
}

export function readSaasConfig(): SaasConfig {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.operon', 'saas.json'), 'utf-8')) as SaasConfig
  } catch {
    return {}
  }
}

/**
 * Normalize a broker base URL for the HTTP tunnel: strip a trailing slash, drop any
 * legacy `/agent/...` path, and convert a ws(s):// scheme back to http(s):// (the
 * node leg is plain HTTP now — SSE downlink + streaming-POST uplink).
 */
export function brokerHttpBase(brokerUrl: string): string {
  return brokerUrl
    .replace(/^ws/, 'http')
    .replace(/\/agent\/(connect|down|up).*$/, '')
    .replace(/\/$/, '')
}
