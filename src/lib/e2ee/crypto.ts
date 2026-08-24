import { xchacha20poly1305 } from '@noble/ciphers/chacha'
import { x25519 } from '@noble/curves/ed25519'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import {
  base64ToBytes,
  bytesToBase64,
  utf8,
  type SealedEnvelope,
  type StoredRemotePairing,
} from '@shared/e2ee/protocol'

const REQUEST_INFO = utf8('operon.remote.request-key.v1')
const RESPONSE_INFO = utf8('operon.remote.response-key.v1')
const PAIRING_INFO = utf8('operon.remote.pairing-key.v1')

export interface RemoteDirectionKeys {
  request: Uint8Array
  response: Uint8Array
}

export function createDeviceKeypair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = x25519.utils.randomPrivateKey()
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) }
}

export function fingerprintPublicKey(publicKey: Uint8Array): string {
  const trimmed = sha256(publicKey).slice(0, 20)
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let bits = 0
  let value = 0
  const out: string[] = []
  for (const byte of trimmed) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out.push(alphabet[(value >>> bits) & 0x1f] ?? '0')
    }
  }
  if (bits > 0) out.push(alphabet[(value << (5 - bits)) & 0x1f] ?? '0')
  return (out.slice(0, 32).join('').match(/.{1,4}/g) ?? []).join('-')
}

export function deriveRemoteDirectionKeys(pairing: StoredRemotePairing): RemoteDirectionKeys {
  const shared = x25519.getSharedSecret(
    base64ToBytes(pairing.devicePrivateKey),
    base64ToBytes(pairing.nodePublicKey),
  )
  const salt = sha256(utf8(`${pairing.desktopId}:${pairing.deviceId}`))
  return {
    request: hkdf(sha256, shared, salt, REQUEST_INFO, 32),
    response: hkdf(sha256, shared, salt, RESPONSE_INFO, 32),
  }
}

export function derivePairingKey(secret: Uint8Array, pairingId: string): Uint8Array {
  return hkdf(sha256, secret, sha256(utf8(pairingId)), PAIRING_INFO, 32)
}

export function seal(plaintext: Uint8Array, key: Uint8Array, aad: Uint8Array): SealedEnvelope {
  const nonce = crypto.getRandomValues(new Uint8Array(24))
  const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(plaintext)
  return { v: 1, nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(ciphertext) }
}

export function open(envelope: SealedEnvelope, key: Uint8Array, aad: Uint8Array): Uint8Array {
  return xchacha20poly1305(key, base64ToBytes(envelope.nonce), aad).decrypt(
    base64ToBytes(envelope.ciphertext),
  )
}
