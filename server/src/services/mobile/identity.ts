import crypto from 'node:crypto'
import os from 'node:os'
import type { StorageAdapter } from '../../storage/interface.js'

// Desktop identity for remote end-to-end encryption. Lives in the `kv` table because it
// survives across process restarts and fits in the existing storage abstraction.
//
// Storage layout (under these kv keys):
//   mobile.identity.desktopId         -> string (uuid)
//   mobile.identity.desktopName       -> string
//   mobile.identity.privateKey        -> base64 raw X25519 private key (32 B)
//   mobile.identity.publicKey         -> base64 raw X25519 public key (32 B)
//
// The X25519 private key never leaves this process.

const KEY_DESKTOP_ID = 'mobile.identity.desktopId'
const KEY_DESKTOP_NAME = 'mobile.identity.desktopName'
const KEY_PRIVATE_KEY = 'mobile.identity.privateKey'
const KEY_PUBLIC_KEY = 'mobile.identity.publicKey'

export interface DesktopIdentity {
  desktopId: string
  desktopName: string
  publicKey: Uint8Array
  fingerprint: string
}

let cached: DesktopIdentity | null = null
let cachedStorage: StorageAdapter | null = null

export function initDesktopIdentity(storage: StorageAdapter): DesktopIdentity {
  cachedStorage = storage

  const existingId = storage.get<string>(KEY_DESKTOP_ID)
  const existingName = storage.get<string>(KEY_DESKTOP_NAME)
  const existingPriv = storage.get<string>(KEY_PRIVATE_KEY)
  const existingPub = storage.get<string>(KEY_PUBLIC_KEY)

  if (existingId && existingName && existingPriv && existingPub) {
    const publicKey = Uint8Array.from(Buffer.from(existingPub, 'base64'))
    cached = {
      desktopId: existingId,
      desktopName: existingName,
      publicKey,
      fingerprint: fingerprintPublicKey(publicKey),
    }
    return cached
  }

  // First run — mint a brand-new identity.
  const { privateKey, publicKey } = generateX25519Keypair()
  const desktopId = existingId ?? crypto.randomUUID()
  const desktopName = existingName ?? defaultDesktopName()

  storage.set(KEY_DESKTOP_ID, desktopId)
  storage.set(KEY_DESKTOP_NAME, desktopName)
  storage.set(KEY_PRIVATE_KEY, Buffer.from(privateKey).toString('base64'))
  storage.set(KEY_PUBLIC_KEY, Buffer.from(publicKey).toString('base64'))

  cached = {
    desktopId,
    desktopName,
    publicKey,
    fingerprint: fingerprintPublicKey(publicKey),
  }
  return cached
}

export function getDesktopIdentity(): DesktopIdentity {
  if (!cached) {
    throw new Error('desktop identity not initialized — call initDesktopIdentity first')
  }
  return cached
}

export function getDesktopPrivateKey(): Uint8Array {
  if (!cachedStorage) {
    throw new Error('desktop identity not initialized — call initDesktopIdentity first')
  }
  const b64 = cachedStorage.get<string>(KEY_PRIVATE_KEY)
  if (!b64) throw new Error('desktop private key missing from storage')
  return Uint8Array.from(Buffer.from(b64, 'base64'))
}

function generateX25519Keypair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' })
  const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' })
  // X25519 SPKI/PKCS8 DER wrap the 32-byte raw key in a fixed-length prefix.
  // The raw bytes are the last 32 octets — this is what @noble/curves expects
  // on the mobile side.
  return {
    publicKey: Uint8Array.from(pubRaw.subarray(pubRaw.length - 32)),
    privateKey: Uint8Array.from(privRaw.subarray(privRaw.length - 32)),
  }
}

export function fingerprintPublicKey(publicKey: Uint8Array): string {
  // SHA-256 → first 20 bytes → Crockford-base32-truncated → 8 groups of 4.
  const digest = crypto.createHash('sha256').update(publicKey).digest()
  const trimmed = digest.subarray(0, 20)
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let bits = 0
  let value = 0
  const out: string[] = []
  for (let i = 0; i < trimmed.length; i += 1) {
    value = (value << 8) | (trimmed[i] ?? 0)
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out.push(alphabet[(value >>> bits) & 0x1f] ?? '0')
    }
  }
  if (bits > 0) {
    out.push(alphabet[(value << (5 - bits)) & 0x1f] ?? '0')
  }
  const truncated = out.slice(0, 32).join('')
  return (truncated.match(/.{1,4}/g) ?? []).join('-')
}

// Auto-derive a name for this desktop from local hardware info so users don't
// have to type one. macOS hostnames usually carry a `.local` suffix; strip it
// for legibility. Fall back to the OS username, then a static label.
function defaultDesktopName(): string {
  try {
    const raw = (os.hostname() || '').trim()
    const cleaned = raw.replace(/\.(local|lan|home)$/i, '').trim()
    if (cleaned) return cleaned
  } catch {
    // ignore
  }
  try {
    const username = os.userInfo().username?.trim()
    if (username) return `${username}'s desktop`
  } catch {
    // ignore
  }
  return 'xui desktop'
}
