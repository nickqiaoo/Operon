import crypto from 'node:crypto'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import {
  DELEGATION_NODE_ID, MACHINE_PEER_SYNC_PATH,
  type MachinePairHello, type MachinePairingCode, type MachinePairingCodeStatus, type MachinePeer, type MachinePeerSync,
} from '@shared/delegations'
import { open, seal } from '@shared/e2ee/crypto'
import { base64ToBytes, bytesToBase64, decodeEnvelope, utf8, type SealedEnvelope } from '@shared/e2ee/protocol'
import { getSaasConfig } from '../gateway/saas/config.js'
import { DelegationHttpError, delegationRequest, listDelegationNodes, pairingClaimRequest } from './delegation-transport.js'
import { cleanLabel, mergePeerRecords, peerRecords, pinPairedPeer, trustedPeerIds } from './machine-peers.js'
import { getDelegationKeypair, getDesktopIdentity } from './mobile/identity.js'

/**
 * Pairing two machines of the account with a code, and keeping the group of
 * paired machines in sync.
 *
 * One machine shows a code; the other enters it and sends a claim, through
 * Broker, to every online machine of the account. The code is 80 random bits
 * that never pass through Broker: the claim and its answer are sealed under a
 * key derived from it, and carry each side's delegation public key, which each
 * then pins (machine-peers.ts). Broker sees only ciphertext, and 80 bits are far
 * beyond guessing offline. Both seals also bind which machine is claiming and
 * which is answering, so Broker cannot redirect a claim either.
 *
 * Joining one member is enough: after a pairing, and every so often, each
 * machine sends the others what it knows of the group (`MachinePeerSync`).
 */

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const SECRET_BYTES = 10
const CODE_TTL_MS = 5 * 60_000
/** Claims that fail to open before the code is withdrawn. 80 bits need no more than a token limit. */
const MAX_FAILED_CLAIMS = 5
const SYNC_DEBOUNCE_MS = 2_000
const SYNC_INTERVAL_MS = 10 * 60_000

export function encodePairingCode(secret: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of secret) {
    value = ((value << 8) | byte) & 0xffff
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += CODE_ALPHABET[(value >>> bits) & 31]
    }
  }
  return (out.match(/.{1,4}/g) ?? []).join('-')
}

/** Forgiving of case, spaces, dashes, and the letters read as digits (O, I, L). Null when not a code. */
export function decodePairingCode(code: string): Uint8Array | null {
  const clean = code.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (clean.length !== (SECRET_BYTES * 8) / 5) return null
  const out = new Uint8Array(SECRET_BYTES)
  let bits = 0
  let value = 0
  let index = 0
  for (const char of clean) {
    const digit = CODE_ALPHABET.indexOf(char)
    if (digit < 0) return null
    value = ((value << 5) | digit) & 0xffff
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out[index++] = (value >>> bits) & 0xff
    }
  }
  return out
}

/** The code's public id (which pending code a claim is for) and its sealing key. */
export function pairingSecrets(secret: Uint8Array): { pairingId: string; key: Uint8Array } {
  const salt = utf8('operon.machine-pair.v1')
  return {
    pairingId: Buffer.from(hkdf(sha256, secret, salt, utf8('operon.machine-pair.id'), 16)).toString('hex'),
    key: hkdf(sha256, secret, salt, utf8('operon.machine-pair.key'), 32),
  }
}

export function pairingAad(pairingId: string, purpose: 'claim' | 'answer', claimer: string, shower: string): Uint8Array {
  return utf8(`operon.machine-pair.v1\n${pairingId}\n${purpose}\n${claimer}\n${shower}`)
}

interface PendingCode {
  pairingId: string
  key: Uint8Array
  expiresAt: number
  failures: number
  peer?: MachinePeer
}

interface Hooks {
  /** A machine was paired with this one by a code, on either side. */
  onPaired?: (peer: MachinePeer) => void
}

let hooks: Hooks = {}
let pending: PendingCode | null = null

export function initMachinePairing(input: Hooks): void {
  hooks = input
}

function selfNodeId(): string {
  const nodeId = getSaasConfig().nodeId
  if (!nodeId) throw new DelegationHttpError(503, 'Connect this machine in Remote settings first')
  return nodeId
}

function ownHello(challenge: string): MachinePairHello {
  return {
    nodeId: selfNodeId(),
    publicKey: bytesToBase64(getDelegationKeypair().publicKey),
    // The name the account's machine list shows, as registered with Broker.
    label: getSaasConfig().label || getDesktopIdentity().desktopName,
    challenge,
  }
}

function parseHello(bytes: Uint8Array): (Omit<MachinePairHello, 'publicKey' | 'label'> & { publicKey: Uint8Array; label: string | null }) | null {
  let value: Partial<MachinePairHello>
  try { value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<MachinePairHello> } catch { return null }
  if (typeof value.nodeId !== 'string' || !DELEGATION_NODE_ID.test(value.nodeId)) return null
  if (typeof value.challenge !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(value.challenge)) return null
  let publicKey: Uint8Array
  try { publicKey = base64ToBytes(typeof value.publicKey === 'string' ? value.publicKey : '') } catch { return null }
  if (publicKey.length !== 32) return null
  return { nodeId: value.nodeId, publicKey, label: cleanLabel(value.label), challenge: value.challenge }
}

function paired(peer: MachinePeer): void {
  try { hooks.onPaired?.(peer) } catch (error) { console.error('[machine-pairing] onPaired failed:', error) }
  schedulePeerSync()
}

// ── The machine showing the code ────────────────────────────────────────────

/** A new code, replacing any this machine was showing. */
export function startPairingCode(): MachinePairingCode {
  selfNodeId()
  const secret = crypto.randomBytes(SECRET_BYTES)
  const { pairingId, key } = pairingSecrets(secret)
  const expiresAt = Date.now() + CODE_TTL_MS
  pending = { pairingId, key, expiresAt, failures: 0 }
  return { code: encodePairingCode(secret), expiresAt }
}

export function pairingCodeStatus(): MachinePairingCodeStatus {
  if (pending?.peer) return { status: 'paired', peer: pending.peer }
  if (!pending || pending.expiresAt <= Date.now()) return { status: 'expired' }
  return { status: 'waiting' }
}

export function cancelPairingCode(): void {
  pending = null
}

/**
 * A claim from `source` (Broker's stamp; the sealed claim must agree). Answers
 * 404 to a claim for a code this machine is not showing, which is how the
 * machine entering a code finds the one showing it.
 */
export function answerPairingClaim(source: string, body: unknown): { status: 200 | 400 | 404; body: Record<string, unknown> } {
  const self = selfNodeId()
  const input = body && typeof body === 'object' ? body as { pairingId?: unknown; envelope?: unknown } : {}
  const current = pending
  if (!current || current.peer || current.expiresAt <= Date.now() || input.pairingId !== current.pairingId) {
    return { status: 404, body: { error: 'pairing_not_found' } }
  }
  let hello: ReturnType<typeof parseHello> = null
  try {
    const envelope = decodeEnvelope(JSON.stringify(input.envelope))
    hello = parseHello(open(envelope, current.key, pairingAad(current.pairingId, 'claim', source, self)))
  } catch { /* counted below */ }
  if (!hello || hello.nodeId !== source || source === self) {
    current.failures += 1
    if (current.failures >= MAX_FAILED_CLAIMS) pending = null
    return { status: 400, body: { error: 'pairing_invalid' } }
  }
  const peer = pinPairedPeer({ nodeId: source, publicKey: hello.publicKey, label: hello.label })
  current.peer = peer
  const answer = seal(utf8(JSON.stringify(ownHello(hello.challenge))), current.key, pairingAad(current.pairingId, 'answer', source, self))
  paired(peer)
  return { status: 200, body: { envelope: answer } }
}

// ── The machine entering the code ───────────────────────────────────────────

/** Pair with whichever online machine of the account is showing `code`. */
export async function joinWithPairingCode(code: string): Promise<MachinePeer> {
  const secret = decodePairingCode(code)
  if (!secret) throw new DelegationHttpError(400, 'That is not a pairing code. It has 16 letters and digits.', 'pairing_code_invalid')
  const self = selfNodeId()
  const { pairingId, key } = pairingSecrets(secret)
  const machines = (await listDelegationNodes()).filter((machine) => !machine.current && machine.online)
  if (!machines.length) throw new DelegationHttpError(404, 'No other machine of this account is online', 'pairing_not_found')
  const challenge = crypto.randomBytes(18).toString('base64url')
  const hello = utf8(JSON.stringify(ownHello(challenge)))

  const claim = async (target: string) => {
    try {
      const envelope = seal(hello, key, pairingAad(pairingId, 'claim', self, target))
      const response = await pairingClaimRequest<{ envelope?: SealedEnvelope }>(target, { pairingId, envelope })
      if (response.status !== 200 || !response.body?.envelope) return null
      const answer = parseHello(open(decodeEnvelope(JSON.stringify(response.body.envelope)), key, pairingAad(pairingId, 'answer', self, target)))
      return answer && answer.nodeId === target && answer.challenge === challenge ? answer : null
    } catch {
      return null
    }
  }
  const found = (await Promise.all(machines.map((machine) => claim(machine.nodeId)))).find((answer) => answer !== null)
  if (!found) {
    throw new DelegationHttpError(404, 'No machine is showing this code. Check the code, and that the machine showing it is online.', 'pairing_not_found')
  }
  const peer = pinPairedPeer({ nodeId: found.nodeId, publicKey: found.publicKey, label: found.label })
  paired(peer)
  return peer
}

// ── Keeping the group in sync ───────────────────────────────────────────────

let syncTimer: ReturnType<typeof setTimeout> | undefined

/** Tell every trusted machine what this one knows, shortly (changes come in bursts). */
export function schedulePeerSync(delayMs = SYNC_DEBOUNCE_MS): void {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncTimer = undefined
    void pushPeerSync()
  }, delayMs)
  syncTimer.unref?.()
}

/** Best effort: a machine that is offline now hears it on the next round. */
export async function pushPeerSync(): Promise<void> {
  try {
    if (!getSaasConfig().nodeId) return
    const targets = trustedPeerIds()
    if (!targets.length) return
    const body: MachinePeerSync = { peers: peerRecords() }
    await Promise.all(targets.map((target) => delegationRequest(target, MACHINE_PEER_SYNC_PATH, body).catch(() => undefined)))
  } catch (error) {
    console.error('[machine-pairing] peer sync failed:', error)
  }
}

/** What a trusted machine sent; passed on when it taught this machine something. */
export function receivePeerSync(source: string, body: unknown): { changed: boolean } {
  const peers = body && typeof body === 'object' && Array.isArray((body as { peers?: unknown }).peers)
    ? (body as { peers: unknown[] }).peers
    : null
  if (!peers) throw new DelegationHttpError(400, 'Invalid request')
  const changed = mergePeerRecords(source, selfNodeId(), peers)
  if (changed) schedulePeerSync()
  return { changed }
}

export function startPeerSync(): () => void {
  const first = setTimeout(() => void pushPeerSync(), 30_000)
  const timer = setInterval(() => void pushPeerSync(), SYNC_INTERVAL_MS)
  first.unref?.()
  timer.unref?.()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
    if (syncTimer) clearTimeout(syncTimer)
    syncTimer = undefined
  }
}

export const machinePairingTestUtils = {
  reset(): void {
    pending = null
    hooks = {}
    if (syncTimer) clearTimeout(syncTimer)
    syncTimer = undefined
  },
}
