import { DELEGATION_NODE_ID, type MachinePeer, type MachinePeerRecord } from '@shared/delegations'
import { base64ToBytes, bytesToBase64 } from '@shared/e2ee/protocol'
import type { MachinePeerRow, MachinePeerStorageAdapter } from '../storage/interface.js'
import { fingerprintPublicKey } from './mobile/identity.js'

/**
 * Which of the account's other machines this one trusts, each pinned to its
 * delegation public key (machine_peers). Requests between machines are sealed
 * with keys derived from these, never from keys Broker hands out: Broker
 * relays them but cannot read or forge them.
 *
 * Trust comes from a pairing code (machine-pairing.ts) or from a trusted machine
 * vouching for another (`mergePeerRecords`). Records of a machine are ordered by
 * `changedAt`; the later wins and, at the same time, a revocation wins. So a
 * revocation made on any machine reaches the others, and re-pairing with a code
 * after it brings the machine back everywhere.
 */

let storage: MachinePeerStorageAdapter | null = null

export function initMachinePeers(adapter: MachinePeerStorageAdapter): void {
  storage = adapter
}

function requireStorage(): MachinePeerStorageAdapter {
  if (!storage) throw new Error('machine peers are not initialized')
  return storage
}

const MAX_LABEL = 120
/** More machines than one account plausibly has; bounds what one sync may write. */
const MAX_RECORDS = 200

export function cleanLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const label = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_LABEL)
  return label || null
}

/** The pinned key of a machine this one trusts; null for any other. */
export function trustedPeerKey(nodeId: string): { publicKey: Uint8Array; fingerprint: string } | null {
  if (!storage) return null
  const row = storage.getMachinePeer(nodeId)
  return row?.status === 'trusted' ? { publicKey: row.publicKey, fingerprint: row.fingerprint } : null
}

/** The name a trusted machine goes by here, as it said when it paired or was introduced. */
export function getMachinePeerLabel(nodeId: string): string | null {
  const row = storage?.getMachinePeer(nodeId)
  return row?.status === 'trusted' ? row.label : null
}

export function isTrustedPeer(nodeId: string): boolean {
  return trustedPeerKey(nodeId) !== null
}

export function trustedPeerIds(): string[] {
  return requireStorage().listMachinePeers().filter((row) => row.status === 'trusted').map((row) => row.nodeId)
}

export function touchPeer(nodeId: string): void {
  storage?.touchMachinePeer(nodeId, Date.now())
}

export function listMachinePeers(): MachinePeer[] {
  return requireStorage().listMachinePeers().map(toMachinePeer)
}

export function toMachinePeer(row: MachinePeerRow): MachinePeer {
  return {
    nodeId: row.nodeId,
    ...(row.label ? { label: row.label } : {}),
    fingerprint: row.fingerprint,
    status: row.status,
    source: row.source,
    ...(row.introducedBy ? { introducedBy: row.introducedBy } : {}),
    changedAt: row.changedAt,
    ...(row.lastSeenAt ? { lastSeenAt: row.lastSeenAt } : {}),
  }
}

/** A machine that showed or entered this machine's pairing code. */
export function pinPairedPeer(input: { nodeId: string; publicKey: Uint8Array; label: string | null; at?: number }): MachinePeer {
  if (!DELEGATION_NODE_ID.test(input.nodeId) || input.publicKey.length !== 32) throw new Error('Invalid machine identity')
  const row = requireStorage().upsertMachinePeer({
    nodeId: input.nodeId,
    publicKey: input.publicKey,
    fingerprint: fingerprintPublicKey(input.publicKey),
    label: input.label,
    status: 'trusted',
    source: 'paired',
    introducedBy: null,
    changedAt: input.at ?? Date.now(),
  })
  return toMachinePeer(row)
}

/** Stop trusting a machine. Null when this machine never knew it. */
export function revokePeer(nodeId: string, at = Date.now()): MachinePeer | null {
  const store = requireStorage()
  const row = store.getMachinePeer(nodeId)
  if (!row) return null
  if (row.status === 'revoked') return toMachinePeer(row)
  const { id: _id, createdAt: _created, lastSeenAt: _seen, ...rest } = row
  return toMachinePeer(store.upsertMachinePeer({ ...rest, status: 'revoked', changedAt: Math.max(at, row.changedAt + 1) }))
}

/** What this machine tells the machines it trusts about the rest (`MachinePeerSync`). */
export function peerRecords(): MachinePeerRecord[] {
  return requireStorage().listMachinePeers().slice(0, MAX_RECORDS).map((row) => ({
    nodeId: row.nodeId,
    publicKey: bytesToBase64(row.publicKey),
    ...(row.label ? { label: row.label } : {}),
    status: row.status,
    changedAt: row.changedAt,
  }))
}

/**
 * Take in what a trusted machine (`from`) knows about the others. A record
 * replaces this machine's own only when it is newer, or as new and a
 * revocation. Records about this machine or about `from` itself are ignored:
 * only a code pairs a machine with this one directly. True when anything changed.
 */
export function mergePeerRecords(from: string, self: string, records: unknown[]): boolean {
  const store = requireStorage()
  if (!isTrustedPeer(from)) return false
  let changed = false
  for (const value of records.slice(0, MAX_RECORDS)) {
    const record = parseRecord(value)
    if (!record || record.nodeId === self || record.nodeId === from) continue
    const local = store.getMachinePeer(record.nodeId)
    if (local) {
      if (local.changedAt > record.changedAt) continue
      if (local.changedAt === record.changedAt && (local.status === 'revoked' || record.status === 'trusted')) continue
    }
    const sameKey = local && bytesToBase64(local.publicKey) === bytesToBase64(record.publicKey) ? local : null
    store.upsertMachinePeer({
      nodeId: record.nodeId,
      publicKey: record.publicKey,
      fingerprint: fingerprintPublicKey(record.publicKey),
      label: record.label ?? local?.label ?? null,
      status: record.status,
      // A revocation or a new label of a machine paired here keeps it "paired"; a new key does not.
      source: sameKey ? sameKey.source : 'introduced',
      introducedBy: sameKey ? sameKey.introducedBy : from,
      changedAt: record.changedAt,
    })
    changed = true
  }
  return changed
}

function parseRecord(value: unknown): (Omit<MachinePeerRecord, 'publicKey'> & { publicKey: Uint8Array }) | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<MachinePeerRecord>
  if (typeof record.nodeId !== 'string' || !DELEGATION_NODE_ID.test(record.nodeId)) return null
  if (record.status !== 'trusted' && record.status !== 'revoked') return null
  if (typeof record.changedAt !== 'number' || !Number.isSafeInteger(record.changedAt) || record.changedAt <= 0) return null
  // A record dated in the future would win over every later change made here.
  if (record.changedAt > Date.now() + 24 * 60 * 60_000) return null
  let publicKey: Uint8Array
  try { publicKey = base64ToBytes(typeof record.publicKey === 'string' ? record.publicKey : '') } catch { return null }
  if (publicKey.length !== 32) return null
  const label = cleanLabel(record.label)
  return { nodeId: record.nodeId, publicKey, ...(label ? { label } : {}), status: record.status, changedAt: record.changedAt }
}
