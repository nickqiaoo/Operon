import crypto from 'node:crypto'
import { DELEGATION_NODE_ID, localNodeIdFor } from '@shared/delegations'
import { getSaasConfig } from '../gateway/saas/config.js'
import { getDelegationKeypair } from './mobile/identity.js'

/**
 * This machine's id among the user's machines and devices.
 *
 * A machine that signed in to Broker uses the id Broker gave it. One that
 * never did uses an id derived from its delegation public key
 * (`localNodeIdFor`), so it needs no account: paired machines and phones pin
 * that id with the key. Broker accepts the derived id when the machine signs
 * in later (it checks the id matches the key it registers), so nothing has to
 * be paired again.
 *
 * Whichever id is in use is kept (KV `identity:node-id`), so signing out of
 * Broker does not change who this machine is to everything already paired
 * with it.
 */

export interface LocalIdentityStorage {
  get<T = unknown>(key: string): T | undefined
  set(key: string, value: unknown): void
}

const KEY = 'identity:node-id'

let storage: LocalIdentityStorage | null = null
let cached: string | undefined

export function initLocalIdentity(adapter: LocalIdentityStorage): void {
  storage = adapter
  cached = undefined
}

function kept(): string | undefined {
  const value = storage?.get<string>(KEY)
  return typeof value === 'string' && DELEGATION_NODE_ID.test(value) ? value : undefined
}

function keep(nodeId: string): void {
  if (storage && kept() !== nodeId) storage.set(KEY, nodeId)
}

/** This machine's own id when it has none from Broker. */
export function derivedNodeId(): string {
  return localNodeIdFor(getDelegationKeypair().publicKey, (data) => crypto.createHash('sha256').update(data).digest())
}

/** The id this machine goes by; always present. */
export function selfNodeId(): string {
  const fromBroker = getSaasConfig().nodeId
  if (fromBroker && DELEGATION_NODE_ID.test(fromBroker)) {
    if (cached !== fromBroker) {
      keep(fromBroker)
      cached = fromBroker
    }
    return fromBroker
  }
  if (cached) return cached
  const nodeId = kept() ?? derivedNodeId()
  keep(nodeId)
  cached = nodeId
  return nodeId
}

export const localIdentityTestUtils = {
  reset(): void {
    storage = null
    cached = undefined
  },
}
