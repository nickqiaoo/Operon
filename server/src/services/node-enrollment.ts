import type { MachinePeer } from '@shared/delegations'
import { BROKER_URL } from '../gateway/saas/broker.js'
import { getSaasConfig, setSaasConfig, clearSaasConfig } from '../gateway/saas/config.js'
import { isSaasRuntimeRunning, startSaasRuntime, stopSaasRuntime } from './saas-runtime.js'
import { DelegationHttpError, listDelegationNodes } from './delegation-transport.js'
import { joinWithPairingCode, startPairingCode } from './machine-pairing.js'

/**
 * Bringing a machine with no browser — a Linux server running the headless node —
 * into the account and pairing it, from one code.
 *
 * Desktop login is loopback OAuth and needs a browser on the same machine. So a
 * machine that is already signed in (the desktop) hands out the code instead,
 * and the server redeems it with `operon node join <code>`. The code is two in
 * one: the first 16 characters are a one-time enrollment code from Broker (it
 * gets the server a node token on this account), the last 16 the pairing code
 * the desktop is showing at the same time (it pins the two machines' keys to
 * each other, see machine-pairing.ts). Both expire in 5 minutes.
 */

const ENROLL_CHARS = 16
const PAIR_CHARS = 16
/** How long the server waits for its own tunnel to come up before pairing. */
const ONLINE_WAIT_MS = 30_000

export interface NodeEnrollmentCode {
  code: string
  expiresAt: number
}

export interface NodeJoinResult {
  userId: string
  nodeId: string
  label: string
  peer: MachinePeer
}

const group = (s: string) => (s.match(/.{1,4}/g) ?? []).join('-')

/** The signed-in machine's half: a code for a server to join this account and pair with this machine. */
export async function createNodeEnrollmentCode(): Promise<NodeEnrollmentCode> {
  const { nodeToken } = getSaasConfig()
  if (!nodeToken) throw new DelegationHttpError(503, 'Sign this machine in first', 'not_signed_in')
  const response = await brokerRequest('/agent/enroll', { method: 'POST', headers: { Authorization: `Bearer ${nodeToken}` } })
  const enroll = (await response.json()) as { code?: string; expiresAt?: number }
  if (!enroll.code || enroll.code.length !== ENROLL_CHARS) throw new DelegationHttpError(502, 'Broker returned no enrollment code')
  const pairing = startPairingCode()
  return {
    code: group(enroll.code + pairing.code.replace(/-/g, '')),
    expiresAt: Math.min(enroll.expiresAt ?? pairing.expiresAt, pairing.expiresAt),
  }
}

/**
 * Splits a join code. The halves use different alphabets — Broker's is RFC 4648
 * base32 (A–Z, 2–7), the pairing code Crockford's — so each half is cleaned up
 * on its own: in the first, a 0/1/8 someone retyped can only have meant O/I/B.
 */
export function parseJoinCode(input: string): { enroll: string; pairing: string } | null {
  const clean = input.toUpperCase().replace(/[\s-]/g, '')
  if (clean.length !== ENROLL_CHARS + PAIR_CHARS) return null
  const enroll = clean.slice(0, ENROLL_CHARS).replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B')
  if (!/^[A-Z2-7]+$/.test(enroll)) return null
  return { enroll, pairing: clean.slice(ENROLL_CHARS) }
}

/**
 * The server's half: redeem the code for a node on the account, bring the
 * tunnel up, let other machines use this one, and pair with the machine that
 * showed the code. Runs inside the server process, so it takes effect without a
 * restart.
 */
export async function joinWithNodeEnrollmentCode(
  input: string,
  label: string,
  allowOtherMachines: (enabled: boolean) => void,
): Promise<NodeJoinResult> {
  const parsed = parseJoinCode(input)
  if (!parsed) {
    throw new DelegationHttpError(400, `That is not a join code. It has ${ENROLL_CHARS + PAIR_CHARS} letters and digits.`, 'enroll_code_invalid')
  }
  const previous = getSaasConfig()
  const response = await brokerRequest('/auth/nodes/enroll/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Broker only reuses the id when it is still this account's: re-joining keeps the node.
    body: JSON.stringify({ code: parsed.enroll, label, nodeId: previous.nodeId }),
  })
  const node = (await response.json()) as { userId?: string; nodeId?: string; nodeToken?: string }
  if (!node.userId || !node.nodeId || !node.nodeToken) throw new DelegationHttpError(502, 'Broker returned no node')

  stopSaasRuntime()
  // No access token: this machine never signed in through a browser. Its node token is all it holds.
  clearSaasConfig()
  setSaasConfig({ userId: node.userId, nodeId: node.nodeId, nodeToken: node.nodeToken, label, connectedAt: Date.now() })
  if (!startSaasRuntime()) throw new DelegationHttpError(500, 'Could not start the connection to Broker')
  // The point of joining: the machine that showed the code is going to use this one.
  allowOtherMachines(true)

  await waitUntilOnline(node.nodeId)
  const peer = await joinWithPairingCode(parsed.pairing)
  return { userId: node.userId, nodeId: node.nodeId, label, peer }
}

/** Sign this machine out: off the account at Broker, then forgotten locally. */
export async function leaveAccount(): Promise<{ revoked: boolean }> {
  const { nodeToken } = getSaasConfig()
  let revoked = false
  if (nodeToken) {
    try {
      const response = await fetch(`${BROKER_URL}/agent/self`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${nodeToken}` }, signal: AbortSignal.timeout(15_000),
      })
      revoked = response.ok
    } catch {
      // Offline: forget it locally anyway; it can still be removed from another machine.
    }
  }
  stopSaasRuntime()
  clearSaasConfig()
  return { revoked }
}

export interface NodeAccountStatus {
  signedIn: boolean
  running: boolean
  online?: boolean
  userId?: string
  nodeId?: string
  label?: string
}

export async function nodeAccountStatus(): Promise<NodeAccountStatus> {
  const config = getSaasConfig()
  const base = { signedIn: !!config.nodeToken, running: isSaasRuntimeRunning(), userId: config.userId, nodeId: config.nodeId, label: config.label }
  if (!config.nodeToken) return base
  try {
    const self = (await listDelegationNodes()).find((machine) => machine.current)
    return { ...base, online: self?.online ?? false }
  } catch {
    return { ...base, online: false }
  }
}

async function waitUntilOnline(nodeId: string): Promise<void> {
  const deadline = Date.now() + ONLINE_WAIT_MS
  for (;;) {
    try {
      const self = (await listDelegationNodes()).find((machine) => machine.nodeId === nodeId)
      if (self?.online) return
    } catch {
      // Broker not answering yet; keep trying until the deadline.
    }
    if (Date.now() > deadline) {
      throw new DelegationHttpError(504, 'Joined the account, but this machine did not come online at Broker. Check its network, then pair with `operon node pair`.', 'node_not_online')
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}

async function brokerRequest(path: string, init: RequestInit): Promise<Response> {
  let response: Response
  try {
    response = await fetch(`${BROKER_URL}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000) })
  } catch {
    throw new DelegationHttpError(503, 'Could not reach Broker', 'broker_unreachable')
  }
  if (response.ok) return response
  const text = await response.text().catch(() => '')
  let body: { error?: string; message?: string } | undefined
  try { body = JSON.parse(text) } catch { /* not JSON */ }
  throw new DelegationHttpError(response.status, body?.message ?? `Broker refused (HTTP ${response.status})`, body?.error)
}
