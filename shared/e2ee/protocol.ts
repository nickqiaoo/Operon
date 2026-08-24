import { sha256 } from '@noble/hashes/sha256'

export const REMOTE_E2EE_VERSION = 'v1' as const

export const E2EE_HEADER = 'X-Operon-E2EE'
export const E2EE_DEVICE_HEADER = 'X-Operon-Device-Id'
export const E2EE_KEY_HEADER = 'X-Operon-Key-Id'
export const E2EE_PROOF_HEADER = 'X-Operon-E2EE-Proof'
export const E2EE_FRAMING_HEADER = 'X-Operon-E2EE-Framing'
export const E2EE_INNER_CONTENT_TYPE_HEADER = 'X-Operon-Inner-Content-Type'
export const E2EE_CONTEXT_HEADER = 'X-Operon-E2EE-Context'
export const REMOTE_TUNNEL_HEADER = 'X-Operon-Remote-Tunnel'
export const PAIRING_HEADER = 'X-Operon-Pairing'

export type RemoteE2EEMode = 'off' | 'required'
export type EncryptedResponseFraming = 'ndjson' | 'sse'

export interface SealedEnvelope {
  v: 1
  nonce: string
  ciphertext: string
}

export interface EncryptedStreamFrame extends SealedEnvelope {
  seq: number
  final: boolean
}

export interface EncryptedWebSocketFrame extends SealedEnvelope {
  seq: number
}

export interface RemotePairingQrPayload {
  v: 1
  brokerUrl: string
  nodeId: string
  desktopId: string
  desktopName: string
  nodePublicKey: string
  nodeFingerprint: string
  pairingId: string
  pairingSecret: string
  expiresAt: number
}

export interface RemotePairingClaim {
  deviceId: string
  deviceName: string
  platform: 'web' | 'ios' | 'android'
  devicePublicKey: string
  deviceFingerprint: string
}

export interface RemotePairingStatus {
  status: 'waiting' | 'pending' | 'confirmed' | 'rejected' | 'expired'
  desktopId?: string
  nodeId?: string
  nodePublicKey?: string
  nodeFingerprint?: string
}

export interface StoredRemotePairing {
  v: 1
  nodeId: string
  desktopId: string
  nodePublicKey: string
  nodeFingerprint: string
  deviceId: string
  devicePrivateKey: string
  devicePublicKey: string
  keyId: string
  pairedAt: number
}

export function requestAad(input: {
  method: string
  apiPath: string
  deviceId: string
  keyId: string
  innerContentType: string
}): Uint8Array {
  return utf8(
    `operon.remote.request.v1\n${input.method.toUpperCase()}\n${input.apiPath}`
    + `\n${input.deviceId}\n${input.keyId}\n${input.innerContentType}`,
  )
}

export function responseFrameAad(input: {
  deviceId: string
  keyId: string
  context: string
  status: number
  framing: EncryptedResponseFraming
  innerContentType: string
  seq: number
  final: boolean
}): Uint8Array {
  return utf8(
    `operon.remote.response.v1\n${input.deviceId}\n${input.keyId}\n${input.context}`
    + `\n${input.status}\n${input.framing}\n${input.innerContentType}\n${input.seq}\n${input.final ? 1 : 0}`,
  )
}

export function responseContext(input: { method: string; apiPath: string; requestNonce: string }): string {
  return bytesToBase64(sha256(utf8(
    `operon.remote.response-context.v1\n${input.method.toUpperCase()}\n${input.apiPath}\n${input.requestNonce}`,
  )))
}

export function pairingAad(pairingId: string, purpose: 'claim' | 'status-proof' | 'status-response'): Uint8Array {
  return utf8(`operon.remote.pairing.v1\n${pairingId}\n${purpose}`)
}

export function webSocketFrameAad(input: {
  direction: 'client-to-server' | 'server-to-client'
  deviceId: string
  keyId: string
  seq: number
}): Uint8Array {
  return utf8(`operon.remote.websocket.v1\n${input.direction}\n${input.deviceId}\n${input.keyId}\n${input.seq}`)
}

export function apiPathFromBrokerUrl(url: string): string {
  const parsed = new URL(url)
  const marker = '/api'
  const index = parsed.pathname.indexOf(marker)
  if (index < 0) throw new Error('Remote request does not contain an API path')
  return `${parsed.pathname.slice(index)}${parsed.search}`
}

export function encodeEnvelope(envelope: SealedEnvelope): string {
  return JSON.stringify(envelope)
}

export function decodeEnvelope(value: string): SealedEnvelope {
  const parsed = JSON.parse(value) as Partial<SealedEnvelope>
  if (parsed.v !== 1 || typeof parsed.nonce !== 'string' || typeof parsed.ciphertext !== 'string') {
    throw new Error('Invalid encrypted envelope')
  }
  return { v: 1, nonce: parsed.nonce, ciphertext: parsed.ciphertext }
}

export function encodeStreamFrame(frame: EncryptedStreamFrame, framing: EncryptedResponseFraming): string {
  const json = JSON.stringify(frame)
  return framing === 'sse' ? `event: operon-e2ee\ndata: ${json}\n\n` : `${json}\n`
}

export function decodeStreamFrame(value: string): EncryptedStreamFrame {
  const parsed = JSON.parse(value) as Partial<EncryptedStreamFrame>
  if (
    parsed.v !== 1 ||
    typeof parsed.seq !== 'number' ||
    !Number.isSafeInteger(parsed.seq) ||
    parsed.seq < 0 ||
    typeof parsed.final !== 'boolean' ||
    typeof parsed.nonce !== 'string' ||
    typeof parsed.ciphertext !== 'string'
  ) {
    throw new Error('Invalid encrypted stream frame')
  }
  return {
    v: 1,
    seq: parsed.seq,
    final: parsed.final,
    nonce: parsed.nonce,
    ciphertext: parsed.ciphertext,
  }
}

export function decodeWebSocketFrame(value: string): EncryptedWebSocketFrame {
  const parsed = JSON.parse(value) as Partial<EncryptedWebSocketFrame>
  if (
    parsed.v !== 1 || typeof parsed.seq !== 'number' || !Number.isSafeInteger(parsed.seq)
    || parsed.seq < 0 || typeof parsed.nonce !== 'string' || typeof parsed.ciphertext !== 'string'
  ) throw new Error('Invalid encrypted WebSocket frame')
  return { v: 1, seq: parsed.seq, nonce: parsed.nonce, ciphertext: parsed.ciphertext }
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

export function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const hasB = i + 1 < bytes.length
    const hasC = i + 2 < bytes.length
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const block = (a << 16) | (b << 8) | c
    out += alphabet[(block >>> 18) & 63]
    out += alphabet[(block >>> 12) & 63]
    out += hasB ? alphabet[(block >>> 6) & 63] : '='
    out += hasC ? alphabet[block & 63] : '='
  }
  return out
}

export function base64ToBytes(value: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const clean = value.replace(/\s+/g, '').replace(/=+$/, '')
  const out: number[] = []
  let bits = 0
  let buffer = 0
  for (const char of clean) {
    const index = alphabet.indexOf(char)
    if (index < 0) throw new Error('Invalid base64')
    buffer = (buffer << 6) | index
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >>> bits) & 0xff)
    }
  }
  return Uint8Array.from(out)
}
