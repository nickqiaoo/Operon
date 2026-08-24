import { hostname } from 'node:os'
import { resolveLocalBase, resolveLocalToken } from './localPort.js'
import { startAgent } from './connection.js'
import { readSaasConfig, brokerHttpBase } from './saasConfig.js'

function env(key: string, def: string): string {
  return process.env[key] || def
}

async function main(): Promise<void> {
  // Prefer explicit env; otherwise fall back to the desktop SaaS login config for
  // the node's identity. The broker address is NOT taken from that file — it is a
  // property of whoever is running this agent, so a standalone agent is configured
  // with BROKER_URL (BROKER_WS is accepted for back-compat and normalized).
  const saas = readSaasConfig()
  const rawBroker = process.env.BROKER_URL ?? process.env.BROKER_WS ?? 'http://127.0.0.1:8080'
  const brokerUrl = brokerHttpBase(rawBroker)
  const secret = process.env.SECRET ?? saas.nodeToken ?? 'dev'
  const nodeId = process.env.NODE_ID ?? saas.nodeId ?? 'dev'
  const label = env('LABEL', saas.label ?? hostname())

  const localBase = await resolveLocalBase()
  const localToken = await resolveLocalToken()
  console.log(`[agent] local backend: ${localBase} (token: ${localToken ? 'yes' : 'no'})`)
  console.log(`[agent] broker:        ${brokerUrl}  (node=${nodeId} label=${label})`)

  startAgent({ brokerUrl, secret, nodeId, label, localBase, localToken })
}

main().catch((err: unknown) => {
  console.error('[agent] fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
