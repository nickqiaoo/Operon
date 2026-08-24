import crypto from 'node:crypto'
import { xchacha20poly1305 } from '@noble/ciphers/chacha'
import { x25519 } from '@noble/curves/ed25519'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import type { MiddlewareHandler } from 'hono'
import type { MobilePairingStorageAdapter } from '../storage/interface.js'
import type { MobilePairingRow, MobilePairingSummary } from '../types/mobile.js'
import { BROKER_URL } from '../gateway/saas/broker.js'
import { getSaasConfig } from '../gateway/saas/config.js'
import {
  E2EE_DEVICE_HEADER,
  E2EE_CONTEXT_HEADER,
  E2EE_FRAMING_HEADER,
  E2EE_HEADER,
  E2EE_INNER_CONTENT_TYPE_HEADER,
  E2EE_KEY_HEADER,
  E2EE_PROOF_HEADER,
  PAIRING_HEADER,
  REMOTE_E2EE_VERSION,
  REMOTE_TUNNEL_HEADER,
  base64ToBytes,
  bytesToBase64,
  decodeEnvelope,
  encodeStreamFrame,
  pairingAad,
  requestAad,
  responseFrameAad,
  responseContext,
  utf8,
  type EncryptedResponseFraming,
  type RemoteE2EEMode,
  type RemotePairingClaim,
  type RemotePairingQrPayload,
  type RemotePairingStatus,
  type SealedEnvelope,
} from '@shared/e2ee/protocol'
import {
  fingerprintPublicKey,
  getDesktopIdentity,
  getDesktopPrivateKey,
} from './mobile/identity.js'

const PAIRING_TTL_MS = 5 * 60 * 1000
const REQUEST_INFO = utf8('operon.remote.request-key.v1')
const RESPONSE_INFO = utf8('operon.remote.response-key.v1')
const PAIRING_INFO = utf8('operon.remote.pairing-key.v1')

interface DirectionKeys {
  request: Uint8Array
  response: Uint8Array
}

interface PendingRemotePairing {
  pairingId: string
  secret: Uint8Array
  nodeId: string
  createdAt: number
  expiresAt: number
  deviceId?: string
}

interface RemoteE2EEState {
  storage: MobilePairingStorageAdapter
  mode: RemoteE2EEMode
}

let state: RemoteE2EEState | null = null
const pendingPairings = new Map<string, PendingRemotePairing>()

export function initRemoteE2EE(input: RemoteE2EEState): void {
  state = input
}

export function getRemoteE2EEMode(): RemoteE2EEMode {
  return state?.mode ?? 'required'
}

function requireState(): RemoteE2EEState {
  if (!state) throw new Error('remote E2EE is not initialized')
  return state
}

function gcPendingPairings(): void {
  const now = Date.now()
  for (const [pairingId, session] of pendingPairings) {
    if (session.expiresAt <= now) pendingPairings.delete(pairingId)
  }
}

export function startRemotePairing(): RemotePairingQrPayload {
  gcPendingPairings()
  const saas = getSaasConfig()
  if (!saas.nodeId || !saas.nodeToken) {
    throw new Error('Connect this machine to Remote before pairing a device')
  }
  const identity = getDesktopIdentity()
  const pairingId = crypto.randomUUID()
  const secret = crypto.randomBytes(32)
  const createdAt = Date.now()
  const expiresAt = createdAt + PAIRING_TTL_MS
  pendingPairings.set(pairingId, {
    pairingId,
    secret,
    nodeId: saas.nodeId,
    createdAt,
    expiresAt,
  })
  return {
    v: 1,
    brokerUrl: BROKER_URL,
    nodeId: saas.nodeId,
    desktopId: identity.desktopId,
    desktopName: identity.desktopName,
    nodePublicKey: bytesToBase64(identity.publicKey),
    nodeFingerprint: identity.fingerprint,
    pairingId,
    pairingSecret: bytesToBase64(secret),
    expiresAt,
  }
}

export function claimRemotePairing(input: {
  pairingId: string
  envelope: SealedEnvelope
}): RemotePairingStatus {
  gcPendingPairings()
  const session = pendingPairings.get(input.pairingId)
  if (!session) return { status: 'expired' }
  const key = derivePairingKey(session.secret, session.pairingId)
  const plaintext = openRemoteEnvelope(input.envelope, key, pairingAad(session.pairingId, 'claim'))
  const claim = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<RemotePairingClaim>
  if (
    typeof claim.deviceId !== 'string' ||
    typeof claim.deviceName !== 'string' ||
    (claim.platform !== 'web' && claim.platform !== 'ios' && claim.platform !== 'android') ||
    typeof claim.devicePublicKey !== 'string' ||
    typeof claim.deviceFingerprint !== 'string'
  ) {
    throw new Error('Invalid pairing claim')
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claim.deviceId)) {
    throw new Error('Invalid pairing device identity')
  }
  const deviceName = claim.deviceName.trim().slice(0, 120)
  if (!deviceName) throw new Error('Pairing device name is required')
  const publicKey = base64ToBytes(claim.devicePublicKey)
  if (publicKey.length !== 32 || fingerprintPublicKey(publicKey) !== claim.deviceFingerprint) {
    throw new Error('Pairing device fingerprint does not match its public key')
  }
  if (session.deviceId && session.deviceId !== claim.deviceId) {
    throw new Error('Pairing request was already claimed')
  }
  const { storage } = requireState()
  const desktop = getDesktopIdentity()
  storage.insertMobilePairing({
    desktopId: desktop.desktopId,
    mobileDeviceId: claim.deviceId,
    mobilePublicKey: publicKey,
    mobileFingerprint: claim.deviceFingerprint,
    mobileLabel: `${deviceName} (${claim.platform})`,
    pairingNonce: session.pairingId,
    status: 'pending',
  })
  session.deviceId = claim.deviceId
  return { status: 'pending' }
}

export function getRemotePairingStatus(input: {
  pairingId: string
  proof: SealedEnvelope
}): SealedEnvelope {
  gcPendingPairings()
  const session = pendingPairings.get(input.pairingId)
  if (!session) throw new Error('Pairing session expired')
  const key = derivePairingKey(session.secret, session.pairingId)
  openRemoteEnvelope(input.proof, key, pairingAad(session.pairingId, 'status-proof'))

  let status: RemotePairingStatus = { status: 'waiting' }
  if (session.deviceId) {
    const desktop = getDesktopIdentity()
    const row = requireState().storage.getMobilePairingByDevice(desktop.desktopId, session.deviceId)
    if (row?.status === 'confirmed') {
      status = {
        status: 'confirmed',
        desktopId: desktop.desktopId,
        nodeId: session.nodeId,
        nodePublicKey: bytesToBase64(desktop.publicKey),
        nodeFingerprint: desktop.fingerprint,
      }
    } else if (row?.status === 'revoked') {
      status = { status: 'rejected' }
    } else if (row) {
      status = { status: 'pending' }
    }
  }
  return sealRemoteEnvelope(utf8(JSON.stringify(status)), key, pairingAad(session.pairingId, 'status-response'))
}

export function inspectRemotePairing(pairingId: string): {
  status: RemotePairingStatus['status']
  expiresAt?: number
  pairing?: MobilePairingSummary
} {
  gcPendingPairings()
  const session = pendingPairings.get(pairingId)
  if (!session) return { status: 'expired' }
  if (!session.deviceId) return { status: 'waiting', expiresAt: session.expiresAt }
  const desktopId = getDesktopIdentity().desktopId
  const row = requireState().storage.getMobilePairingByDevice(desktopId, session.deviceId)
  if (!row) return { status: 'waiting', expiresAt: session.expiresAt }
  return {
    status: row.status === 'revoked' ? 'rejected' : row.status,
    expiresAt: session.expiresAt,
    pairing: toSummary(row),
  }
}

export function approveRemotePairing(pairingId: string): MobilePairingSummary {
  const session = pendingPairings.get(pairingId)
  if (!session || session.expiresAt <= Date.now() || !session.deviceId) {
    throw new Error('Pairing request is missing or expired')
  }
  const row = requireState().storage.confirmMobilePairing(pairingId, Date.now())
  if (!row) throw new Error('Pairing request is no longer available')
  return toSummary(row)
}

export function rejectRemotePairing(pairingId: string): void {
  const session = pendingPairings.get(pairingId)
  if (!session?.deviceId) {
    pendingPairings.delete(pairingId)
    return
  }
  const desktopId = getDesktopIdentity().desktopId
  const row = requireState().storage.getMobilePairingByDevice(desktopId, session.deviceId)
  if (row) requireState().storage.setMobilePairingStatus(row.id, 'revoked', Date.now())
}

export function listRemoteDevices(): MobilePairingSummary[] {
  const desktopId = getDesktopIdentity().desktopId
  return requireState().storage.listMobilePairings(desktopId).map(toSummary)
}

export function revokeRemoteDevice(id: number): void {
  requireState().storage.setMobilePairingStatus(id, 'revoked', Date.now())
}

export function createRemoteE2EEMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.header(REMOTE_TUNNEL_HEADER) !== '1') {
      await next()
      return
    }
    // WebSocket messages have their own ordered frame wrapper. The HTTP
    // handshake cannot carry a browser-defined header, so the terminal route
    // validates query-bound device identity before upgrading the connection.
    if (c.req.path === '/api/terminal/ws') {
      await next()
      return
    }
    const isPairingRequest = c.req.path.startsWith('/api/e2ee/pair/') && c.req.header(PAIRING_HEADER) === REMOTE_E2EE_VERSION
    if (isPairingRequest) {
      await next()
      return
    }
    if (c.req.header(E2EE_HEADER) !== REMOTE_E2EE_VERSION) {
      if (getRemoteE2EEMode() === 'off') {
        await next()
        return
      }
      c.res = c.json({ error: 'e2ee_required', message: 'Secure pairing is required' }, 426)
      return
    }

    const deviceId = c.req.header(E2EE_DEVICE_HEADER)
    const keyId = c.req.header(E2EE_KEY_HEADER)
    if (!deviceId || !keyId) {
      c.res = c.json({ error: 'e2ee_invalid', message: 'Missing E2EE device identity' }, 400)
      return
    }
    const desktopId = getDesktopIdentity().desktopId
    const row = requireState().storage.getMobilePairingByDevice(desktopId, deviceId)
    if (!row || row.status !== 'confirmed') {
      c.res = c.json({ error: 'e2ee_device_untrusted', message: 'This device is not paired' }, 403)
      return
    }
    if (keyId !== row.mobileFingerprint) {
      c.res = c.json({ error: 'e2ee_key_invalid', message: 'Encrypted key identity does not match' }, 403)
      return
    }

    const keys = deriveDirectionKeys(row)
    let responseBinding = ''
    try {
      const apiPath = `${c.req.path}${new URL(c.req.url).search}`
      const raw = c.req.raw
      const innerContentType = raw.headers.get(E2EE_INNER_CONTENT_TYPE_HEADER) ?? ''
      const aad = requestAad({ method: c.req.method, apiPath, deviceId, keyId, innerContentType })
      const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD'
      const encoded = hasBody ? await raw.text() : c.req.header(E2EE_PROOF_HEADER)
      if (!encoded) throw new Error('Missing encrypted request payload')
      const envelope = decodeEnvelope(encoded)
      const plaintext = openRemoteEnvelope(envelope, keys.request, aad)
      const headers = new Headers(raw.headers)
      for (const name of [
        E2EE_HEADER,
        E2EE_DEVICE_HEADER,
        E2EE_KEY_HEADER,
        E2EE_PROOF_HEADER,
        E2EE_INNER_CONTENT_TYPE_HEADER,
        REMOTE_TUNNEL_HEADER,
      ]) {
        headers.delete(name)
      }
      if (innerContentType) headers.set('content-type', innerContentType)
      else headers.delete('content-type')
      headers.delete('content-length')
      const body = hasBody ? toArrayBuffer(plaintext) : undefined
      c.req.raw = new Request(raw.url, {
        method: raw.method,
        headers,
        body,
        signal: raw.signal,
      })
      c.req.bodyCache = {}
      responseBinding = responseContext({
        method: c.req.method,
        apiPath,
        requestNonce: envelope.nonce,
      })
    } catch (error) {
      c.res = c.json({
        error: 'e2ee_invalid',
        message: error instanceof Error ? error.message : 'Encrypted request failed',
      }, 400)
      return
    }

    try {
      await next()
    } catch (error) {
      console.error('Server error:', error)
      c.res = c.json({
        error: error instanceof Error ? error.message : 'Internal server error',
      }, 500)
    }
    requireState().storage.touchMobilePairingLastSeen(desktopId, deviceId, Date.now())
    c.res = encryptResponse(c.res, keys.response, {
      deviceId,
      keyId,
      context: responseBinding,
    })
  }
}

export function getConfirmedRemoteDeviceKeys(deviceId: string, keyId?: string): DirectionKeys | null {
  const desktopId = getDesktopIdentity().desktopId
  const row = requireState().storage.getMobilePairingByDevice(desktopId, deviceId)
  if (!row || row.status !== 'confirmed' || (keyId && keyId !== row.mobileFingerprint)) return null
  return deriveDirectionKeys(row)
}

function encryptResponse(
  response: Response,
  key: Uint8Array,
  identity: { deviceId: string; keyId: string; context: string },
): Response {
  const headers = new Headers(response.headers)
  const innerContentType = headers.get('content-type') ?? ''
  const framing: EncryptedResponseFraming = innerContentType.toLowerCase().includes('text/event-stream')
    ? 'sse'
    : 'ndjson'
  headers.set(E2EE_HEADER, REMOTE_E2EE_VERSION)
  headers.set(E2EE_CONTEXT_HEADER, identity.context)
  headers.set(E2EE_FRAMING_HEADER, framing)
  headers.set(E2EE_INNER_CONTENT_TYPE_HEADER, innerContentType)
  headers.set('content-type', framing === 'sse' ? 'text/event-stream' : 'application/x-ndjson')
  // Ciphertext is bound to this request's random nonce. Letting a browser cache
  // and replay it for a later request would correctly fail authentication but
  // look like a broken attachment, so only decrypted application caches may
  // retain content.
  headers.set('cache-control', 'no-store')
  headers.delete('etag')
  headers.delete('last-modified')
  headers.delete('content-length')

  if (!response.body || response.status === 204 || response.status === 304) {
    return new Response(null, { status: response.status, statusText: response.statusText, headers })
  }
  const source = response.body.getReader()
  let seq = 0
  const encrypted = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await source.read()
        const final = done
        const plaintext = value ?? new Uint8Array()
        const aad = responseFrameAad({
          ...identity,
          status: response.status,
          framing,
          innerContentType,
          seq,
          final,
        })
        const frame = { ...sealRemoteEnvelope(plaintext, key, aad), seq, final }
        controller.enqueue(utf8(encodeStreamFrame(frame, framing)))
        seq += 1
        if (done) controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
    cancel(reason) {
      return source.cancel(reason)
    },
  })
  return new Response(encrypted, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function deriveDirectionKeys(row: MobilePairingRow): DirectionKeys {
  const shared = x25519.getSharedSecret(getDesktopPrivateKey(), row.mobilePublicKey)
  const salt = sha256(utf8(`${row.desktopId}:${row.mobileDeviceId}`))
  return {
    request: hkdf(sha256, shared, salt, REQUEST_INFO, 32),
    response: hkdf(sha256, shared, salt, RESPONSE_INFO, 32),
  }
}

function derivePairingKey(secret: Uint8Array, pairingId: string): Uint8Array {
  return hkdf(sha256, secret, sha256(utf8(pairingId)), PAIRING_INFO, 32)
}

export function sealRemoteEnvelope(plaintext: Uint8Array, key: Uint8Array, aad: Uint8Array): SealedEnvelope {
  const nonce = crypto.randomBytes(24)
  const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(plaintext)
  return {
    v: 1,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertext),
  }
}

export function openRemoteEnvelope(envelope: SealedEnvelope, key: Uint8Array, aad: Uint8Array): Uint8Array {
  return xchacha20poly1305(key, base64ToBytes(envelope.nonce), aad).decrypt(
    base64ToBytes(envelope.ciphertext),
  )
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function toSummary(row: MobilePairingRow): MobilePairingSummary {
  return {
    id: row.id,
    desktopId: row.desktopId,
    mobileDeviceId: row.mobileDeviceId,
    mobileFingerprint: row.mobileFingerprint,
    mobileLabel: row.mobileLabel,
    status: row.status,
    createdAt: row.createdAt,
    confirmedAt: row.confirmedAt,
    lastSeenAt: row.lastSeenAt,
  }
}

export const remoteE2EETestUtils = {
  derivePairingKey,
}
