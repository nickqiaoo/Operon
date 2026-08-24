import {
  PAIRING_HEADER,
  REMOTE_E2EE_VERSION,
  E2EE_PROOF_HEADER,
  base64ToBytes,
  bytesToBase64,
  decodeEnvelope,
  pairingAad,
  utf8,
  type RemotePairingClaim,
  type RemotePairingQrPayload,
  type RemotePairingStatus,
  type StoredRemotePairing,
} from '@shared/e2ee/protocol'
import { nativePlatform } from '../native'
import { getUserId } from '../web-auth'
import { createDeviceKeypair, derivePairingKey, fingerprintPublicKey, open, seal } from './crypto'
import { getOrCreateDeviceId, saveRemotePairing } from './device-store'

export function parsePairingQr(value: string): RemotePairingQrPayload {
  const parsed = JSON.parse(value) as Partial<RemotePairingQrPayload>
  if (
    parsed.v !== 1 || typeof parsed.brokerUrl !== 'string' || typeof parsed.nodeId !== 'string'
    || typeof parsed.desktopId !== 'string' || typeof parsed.desktopName !== 'string' || typeof parsed.nodePublicKey !== 'string'
    || typeof parsed.nodeFingerprint !== 'string' || typeof parsed.pairingId !== 'string'
    || typeof parsed.pairingSecret !== 'string' || typeof parsed.expiresAt !== 'number'
  ) throw new Error('This pairing code is invalid')
  if (parsed.expiresAt <= Date.now()) throw new Error('This pairing code has expired')
  return parsed as RemotePairingQrPayload
}

export async function pairRemoteNode(input: {
  qr: RemotePairingQrPayload
  expectedNodeId: string
  deviceName: string
  signal?: AbortSignal
  onStatus?: (status: RemotePairingStatus['status']) => void
}): Promise<StoredRemotePairing> {
  const { qr } = input
  if (qr.nodeId !== input.expectedNodeId) throw new Error('This code belongs to a different machine')
  const expectedBroker = (import.meta.env.VITE_BROKER_URL ?? '').replace(/\/$/, '')
  if (qr.brokerUrl.replace(/\/$/, '') !== expectedBroker) throw new Error('This code belongs to a different service')
  const nodePublicKey = base64ToBytes(qr.nodePublicKey)
  if (fingerprintPublicKey(nodePublicKey) !== qr.nodeFingerprint) {
    throw new Error('The machine identity in this code is invalid')
  }
  const pairingSecret = base64ToBytes(qr.pairingSecret)
  if (pairingSecret.length !== 32) throw new Error('The pairing secret is invalid')

  const deviceId = await getOrCreateDeviceId()
  const deviceKeys = createDeviceKeypair()
  const deviceFingerprint = fingerprintPublicKey(deviceKeys.publicKey)
  const platform = nativePlatform()
  const claim: RemotePairingClaim = {
    deviceId,
    deviceName: input.deviceName,
    platform,
    devicePublicKey: bytesToBase64(deviceKeys.publicKey),
    deviceFingerprint,
  }
  const key = derivePairingKey(pairingSecret, qr.pairingId)
  const userId = getUserId()
  if (!userId) throw new Error('Sign in before pairing this machine')
  const pairBase = `${qr.brokerUrl.replace(/\/$/, '')}/u/${encodeURIComponent(userId)}/n/${encodeURIComponent(qr.nodeId)}/api/e2ee/pair`
  const headers = { 'content-type': 'application/json', [PAIRING_HEADER]: REMOTE_E2EE_VERSION }
  const claimRes = await fetch(`${pairBase}/claim`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ pairingId: qr.pairingId, envelope: seal(utf8(JSON.stringify(claim)), key, pairingAad(qr.pairingId, 'claim')) }),
    signal: input.signal,
  })
  if (!claimRes.ok) throw new Error(await responseError(claimRes, 'Could not send the pairing request'))
  const claimStatus = await claimRes.json().catch(() => null) as RemotePairingStatus | null
  if (claimStatus?.status === 'expired') throw new Error('This pairing code has expired')
  input.onStatus?.('pending')

  while (Date.now() < qr.expiresAt) {
    await delay(1_000, input.signal)
    const proof = seal(new Uint8Array(), key, pairingAad(qr.pairingId, 'status-proof'))
    const res = await fetch(`${pairBase}/status/${encodeURIComponent(qr.pairingId)}`, {
      headers: { [PAIRING_HEADER]: REMOTE_E2EE_VERSION, [E2EE_PROOF_HEADER]: JSON.stringify(proof) },
      signal: input.signal,
    })
    if (!res.ok) throw new Error(await responseError(res, 'Could not check pairing approval'))
    const envelope = decodeEnvelope(JSON.stringify(await res.json()))
    const status = JSON.parse(new TextDecoder().decode(open(envelope, key, pairingAad(qr.pairingId, 'status-response')))) as RemotePairingStatus
    input.onStatus?.(status.status)
    if (status.status === 'rejected') throw new Error('The pairing request was rejected')
    if (status.status === 'confirmed') {
      if (status.nodePublicKey !== qr.nodePublicKey || status.nodeFingerprint !== qr.nodeFingerprint) {
        throw new Error('The approved machine identity changed during pairing')
      }
      const pairing: StoredRemotePairing = {
        v: 1,
        nodeId: qr.nodeId,
        desktopId: qr.desktopId,
        nodePublicKey: qr.nodePublicKey,
        nodeFingerprint: qr.nodeFingerprint,
        deviceId,
        devicePrivateKey: bytesToBase64(deviceKeys.privateKey),
        devicePublicKey: bytesToBase64(deviceKeys.publicKey),
        keyId: deviceFingerprint,
        pairedAt: Date.now(),
      }
      await saveRemotePairing(pairing)
      return pairing
    }
  }
  throw new Error('This pairing code has expired')
}

async function responseError(res: Response, fallback: string): Promise<string> {
  const value = await res.json().catch(() => null) as { message?: unknown; error?: unknown } | null
  return typeof value?.message === 'string' ? value.message : typeof value?.error === 'string' ? value.error : fallback
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Pairing cancelled', 'AbortError'))
      return
    }
    const onAbort = () => {
      window.clearTimeout(timer)
      reject(new DOMException('Pairing cancelled', 'AbortError'))
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
