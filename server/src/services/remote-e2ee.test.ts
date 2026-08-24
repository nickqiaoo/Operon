import { beforeAll, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import {
  E2EE_CONTEXT_HEADER,
  E2EE_DEVICE_HEADER,
  E2EE_HEADER,
  E2EE_INNER_CONTENT_TYPE_HEADER,
  E2EE_KEY_HEADER,
  REMOTE_TUNNEL_HEADER,
  bytesToBase64,
  decodeStreamFrame,
  requestAad,
  responseContext,
  responseFrameAad,
  utf8,
  type StoredRemotePairing,
} from '@shared/e2ee/protocol'
import type { MobilePairingStorageAdapter, StorageAdapter } from '../storage/interface.js'
import type { CreateMobilePairingInput, MobilePairingRow, MobilePairingStatus } from '../types/mobile.js'
import { fingerprintPublicKey, initDesktopIdentity } from './mobile/identity.js'
import { createDeviceKeypair, deriveRemoteDirectionKeys, open, seal } from '../../../src/lib/e2ee/crypto.js'
import { createRemoteE2EEMiddleware, initRemoteE2EE } from './remote-e2ee.js'

let storage: TestStorage
let pairing: StoredRemotePairing

beforeAll(() => {
  storage = new TestStorage()
  const desktop = initDesktopIdentity(storage)
  const device = createDeviceKeypair()
  const deviceId = crypto.randomUUID()
  const keyId = fingerprintPublicKey(device.publicKey)
  storage.insertMobilePairing({
    desktopId: desktop.desktopId,
    mobileDeviceId: deviceId,
    mobilePublicKey: device.publicKey,
    mobileFingerprint: keyId,
    pairingNonce: crypto.randomUUID(),
    status: 'confirmed',
  })
  pairing = {
    v: 1,
    nodeId: 'node-test',
    desktopId: desktop.desktopId,
    nodePublicKey: bytesToBase64(desktop.publicKey),
    nodeFingerprint: desktop.fingerprint,
    deviceId,
    devicePrivateKey: bytesToBase64(device.privateKey),
    devicePublicKey: bytesToBase64(device.publicKey),
    keyId,
    pairedAt: Date.now(),
  }
})

describe('remote E2EE middleware', () => {
  it('decrypts a generic request and independently encrypts streamed response frames', async () => {
    initRemoteE2EE({ storage, mode: 'required' })
    const app = new Hono()
    app.use('/api/*', createRemoteE2EEMiddleware())
    app.post('/api/echo', async (c) => c.json({ received: await c.req.json() }))

    const keys = deriveRemoteDirectionKeys(pairing)
    const apiPath = '/api/echo?test=1'
    const aad = requestAad({
      method: 'POST',
      apiPath,
      deviceId: pairing.deviceId,
      keyId: pairing.keyId,
      innerContentType: 'application/json',
    })
    const envelope = seal(utf8(JSON.stringify({ secret: 'broker cannot read this' })), keys.request, aad)
    const context = responseContext({ method: 'POST', apiPath, requestNonce: envelope.nonce })
    const response = await app.request(`http://localhost${apiPath}`, {
      method: 'POST',
      headers: {
        [REMOTE_TUNNEL_HEADER]: '1',
        [E2EE_HEADER]: 'v1',
        [E2EE_DEVICE_HEADER]: pairing.deviceId,
        [E2EE_KEY_HEADER]: pairing.keyId,
        [E2EE_INNER_CONTENT_TYPE_HEADER]: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(envelope),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get(E2EE_HEADER)).toBe('v1')
    expect(response.headers.get(E2EE_CONTEXT_HEADER)).toBe(context)
    const plaintext: Uint8Array[] = []
    for (const line of (await response.text()).trim().split('\n')) {
      const frame = decodeStreamFrame(line)
      plaintext.push(open(
        frame,
        keys.response,
        responseFrameAad({
          deviceId: pairing.deviceId,
          keyId: pairing.keyId,
          context,
          status: response.status,
          framing: 'ndjson',
          innerContentType: 'application/json',
          seq: frame.seq,
          final: frame.final,
        }),
      ))
    }
    const decoded = new TextDecoder().decode(concat(plaintext))
    expect(JSON.parse(decoded)).toEqual({ received: { secret: 'broker cannot read this' } })
  })

  it('rejects plaintext remote requests in required mode but permits them in developer off mode', async () => {
    const required = new Hono()
    initRemoteE2EE({ storage, mode: 'required' })
    required.use('/api/*', createRemoteE2EEMiddleware())
    required.get('/api/value', (c) => c.json({ ok: true }))
    expect((await required.request('/api/value', { headers: { [REMOTE_TUNNEL_HEADER]: '1' } })).status).toBe(426)

    const developer = new Hono()
    initRemoteE2EE({ storage, mode: 'off' })
    developer.use('/api/*', createRemoteE2EEMiddleware())
    developer.get('/api/value', (c) => c.json({ ok: true }))
    const response = await developer.request('/api/value', { headers: { [REMOTE_TUNNEL_HEADER]: '1' } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })
})

function concat(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

class TestStorage implements StorageAdapter, MobilePairingStorageAdapter {
  private readonly values = new Map<string, unknown>()
  private readonly pairings: MobilePairingRow[] = []
  private nextId = 1

  get<T = unknown>(key: string): T | undefined { return this.values.get(key) as T | undefined }
  set<T = unknown>(key: string, value: T): void { this.values.set(key, value) }
  delete(key: string): void { this.values.delete(key) }
  getAll<T = unknown>(): T | undefined { return Object.fromEntries(this.values) as T }
  setAll<T = unknown>(data: T): void {
    this.values.clear()
    if (typeof data === 'object' && data) {
      for (const [key, value] of Object.entries(data)) this.values.set(key, value)
    }
  }
  keys(prefix = ''): string[] { return [...this.values.keys()].filter((key) => key.startsWith(prefix)) }

  insertMobilePairing(input: CreateMobilePairingInput): MobilePairingRow {
    const previous = this.getMobilePairingByDevice(input.desktopId, input.mobileDeviceId)
    if (previous) {
      Object.assign(previous, {
        mobilePublicKey: input.mobilePublicKey,
        mobileFingerprint: input.mobileFingerprint,
        pairingNonce: input.pairingNonce,
        status: input.status,
      })
      return previous
    }
    const row: MobilePairingRow = {
      id: this.nextId++,
      desktopId: input.desktopId,
      mobileDeviceId: input.mobileDeviceId,
      mobilePublicKey: input.mobilePublicKey,
      mobileFingerprint: input.mobileFingerprint,
      mobileLabel: input.mobileLabel ?? null,
      pairingNonce: input.pairingNonce,
      status: input.status,
      createdAt: Date.now(),
      confirmedAt: input.status === 'confirmed' ? Date.now() : null,
      revokedAt: null,
      lastSeenAt: null,
    }
    this.pairings.push(row)
    return row
  }
  getMobilePairingByNonce(nonce: string): MobilePairingRow | null {
    return this.pairings.find((row) => row.pairingNonce === nonce) ?? null
  }
  getMobilePairingByDevice(desktopId: string, deviceId: string): MobilePairingRow | null {
    return this.pairings.find((row) => row.desktopId === desktopId && row.mobileDeviceId === deviceId) ?? null
  }
  listMobilePairings(desktopId: string): MobilePairingRow[] {
    return this.pairings.filter((row) => row.desktopId === desktopId && row.status !== 'revoked')
  }
  confirmMobilePairing(nonce: string, confirmedAt: number): MobilePairingRow | null {
    const row = this.getMobilePairingByNonce(nonce)
    if (!row) return null
    row.status = 'confirmed'
    row.confirmedAt = confirmedAt
    return row
  }
  setMobilePairingStatus(id: number, status: MobilePairingStatus, ts: number): void {
    const row = this.pairings.find((item) => item.id === id)
    if (!row) return
    row.status = status
    if (status === 'revoked') row.revokedAt = ts
    if (status === 'confirmed') row.confirmedAt = ts
  }
  touchMobilePairingLastSeen(desktopId: string, deviceId: string, ts: number): void {
    const row = this.getMobilePairingByDevice(desktopId, deviceId)
    if (row) row.lastSeenAt = ts
  }
}
