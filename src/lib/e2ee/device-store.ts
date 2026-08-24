import type { StoredRemotePairing } from '@shared/e2ee/protocol'
import { isNativeApp, secureGet, secureRemove, secureSet } from '../native'

const DB_NAME = 'operon-e2ee'
const STORE_NAME = 'pairings'
const NATIVE_PREFIX = 'operon.e2ee.pairing.'
const DEVICE_ID_KEY = 'operon.e2ee.device-id'

export async function getRemotePairing(nodeId: string): Promise<StoredRemotePairing | null> {
  if (isNativeApp()) {
    const raw = await secureGet(`${NATIVE_PREFIX}${nodeId}`)
    return raw ? parsePairing(raw) : null
  }
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(nodeId)
    request.onsuccess = () => resolve(isStoredPairing(request.result) ? request.result : null)
    request.onerror = () => reject(request.error)
  })
}

export async function hasRemotePairing(nodeId: string): Promise<boolean> {
  return (await getRemotePairing(nodeId)) !== null
}

export async function saveRemotePairing(pairing: StoredRemotePairing): Promise<void> {
  if (isNativeApp()) {
    const key = `${NATIVE_PREFIX}${pairing.nodeId}`
    const value = JSON.stringify(pairing)
    await secureSet(key, value)
    if (await secureGet(key) !== value) throw new Error('Could not save the secure device key')
    return
  }
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(pairing)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

export async function removeRemotePairing(nodeId: string): Promise<void> {
  if (isNativeApp()) {
    await secureRemove(`${NATIVE_PREFIX}${nodeId}`)
    return
  }
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(nodeId)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

export async function getOrCreateDeviceId(): Promise<string> {
  if (isNativeApp()) {
    const existing = await secureGet(DEVICE_ID_KEY)
    if (existing) return existing
    const created = crypto.randomUUID()
    await secureSet(DEVICE_ID_KEY, created)
    if (await secureGet(DEVICE_ID_KEY) !== created) throw new Error('Could not save the secure device identity')
    return created
  }
  const existing = localStorage.getItem(DEVICE_ID_KEY)
  if (existing) return existing
  const created = crypto.randomUUID()
  localStorage.setItem(DEVICE_ID_KEY, created)
  return created
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'nodeId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function parsePairing(raw: string): StoredRemotePairing | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isStoredPairing(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isStoredPairing(value: unknown): value is StoredRemotePairing {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<StoredRemotePairing>
  return item.v === 1
    && typeof item.nodeId === 'string'
    && typeof item.desktopId === 'string'
    && typeof item.nodePublicKey === 'string'
    && typeof item.deviceId === 'string'
    && typeof item.devicePrivateKey === 'string'
    && typeof item.devicePublicKey === 'string'
    && typeof item.keyId === 'string'
}
