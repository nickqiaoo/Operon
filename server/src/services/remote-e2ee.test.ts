import { beforeAll, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import {
  E2EE_CONTEXT_HEADER,
  E2EE_DEVICE_HEADER,
  E2EE_HEADER,
  E2EE_INNER_CONTENT_TYPE_HEADER,
  E2EE_KEY_HEADER,
  E2EE_PROOF_HEADER,
  REMOTE_TUNNEL_HEADER,
  base64ToBytes,
  bytesToBase64,
  decodeStreamFrame,
  encodeEnvelope,
  pairingAad,
  requestAad,
  responseContext,
  responseFrameAad,
  utf8,
  type StoredRemotePairing,
} from '@shared/e2ee/protocol'
import type { MobilePairingStorageAdapter, StorageAdapter } from '../storage/interface.js'
import type { CreateMobilePairingInput, MobilePairingRow, MobilePairingStatus } from '../types/mobile.js'
import { fingerprintPublicKey, initDesktopIdentity } from './mobile/identity.js'
import { createDeviceKeypair, derivePairingKey, deriveRemoteDirectionKeys, open, seal } from '@shared/e2ee/crypto'
import {
  approveRemotePairing,
  claimRemotePairing,
  createRemoteE2EEMiddleware,
  getPairingApprovalNonce,
  initRemoteE2EE,
  requiresSecureApproval,
  startRemotePairing,
} from './remote-e2ee.js'
import { remoteE2EERoutes } from '../routes/remote-e2ee.js'
import { getConfirmedRemoteDeviceKeys } from './remote-e2ee.js'
import { createDirectIngress } from './direct-ingress.js'
import { serve } from '@hono/node-server'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'

// startRemotePairing refuses without a connected node; the values are otherwise
// opaque to the approval path under test.
vi.mock('../gateway/saas/config.js', () => ({
  getSaasConfig: () => ({ nodeId: 'node-test', nodeToken: 'token-test' }),
}))

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

  it("drops the route's own length and cache headers instead of carrying them onto the ciphertext", async () => {
    initRemoteE2EE({ storage, mode: 'required' })
    const app = new Hono()
    app.use('/api/*', createRemoteE2EEMiddleware())
    // Shaped like the attachment route: explicit length, immutable caching.
    const bytes = new Uint8Array(4096).map((_, i) => i % 251)
    app.get('/api/blob', (c) => c.body(bytes.buffer, 200, {
      'Content-Type': 'image/png',
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'public, max-age=31536000, immutable',
    }))

    const keys = deriveRemoteDirectionKeys(pairing)
    const apiPath = '/api/blob'
    const envelope = seal(new Uint8Array(), keys.request, requestAad({
      method: 'GET',
      apiPath,
      deviceId: pairing.deviceId,
      keyId: pairing.keyId,
      innerContentType: '',
    }))
    const context = responseContext({ method: 'GET', apiPath, requestNonce: envelope.nonce })
    const response = await app.request(`http://localhost${apiPath}`, {
      headers: {
        [REMOTE_TUNNEL_HEADER]: '1',
        [E2EE_HEADER]: 'v1',
        [E2EE_DEVICE_HEADER]: pairing.deviceId,
        [E2EE_KEY_HEADER]: pairing.keyId,
        [E2EE_PROOF_HEADER]: encodeEnvelope(envelope),
      },
    })

    // A plaintext Content-Length truncates the longer ciphertext; immutable
    // caching lets a client replay a response bound to another request's nonce.
    expect(response.headers.get('content-length')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store')
    const frames = (await response.text()).trim().split('\n').map(decodeStreamFrame)
    expect(frames.at(-1)?.final).toBe(true)
    const plaintext = concat(frames.map((frame) => open(frame, keys.response, responseFrameAad({
      deviceId: pairing.deviceId,
      keyId: pairing.keyId,
      context,
      status: 200,
      framing: 'ndjson',
      innerContentType: 'image/png',
      seq: frame.seq,
      final: frame.final,
    }))))
    expect(plaintext).toEqual(bytes)
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

  it('lets broker-verified webhook events through in required mode without a device key', async () => {
    const app = new Hono()
    initRemoteE2EE({ storage, mode: 'required' })
    app.use('/api/*', createRemoteE2EEMiddleware())
    app.post('/api/integrations/events/linear', async (c) => c.json({ received: await c.req.json() }))
    app.get('/api/integrations/status', (c) => c.json({ ok: true }))
    const webhook = await app.request('/api/integrations/events/linear', {
      method: 'POST',
      headers: { [REMOTE_TUNNEL_HEADER]: '1', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'created' }),
    })
    expect(webhook.status).toBe(200)
    expect(await webhook.json()).toEqual({ received: { action: 'created' } })
    // Only the events prefix is exempt; the rest of /api/integrations still needs E2EE.
    expect((await app.request('/api/integrations/status', { headers: { [REMOTE_TUNNEL_HEADER]: '1' } })).status).toBe(426)
  })
})

/**
 * A paired phone reaching this machine directly over Tailscale: through the
 * direct listener (as Tailscale Serve hands it on) to the real middleware.
 */
describe('a paired phone through the direct listener', () => {
  const listening = (server: http.Server) => new Promise<number>((resolve) => {
    if (server.listening) resolve((server.address() as AddressInfo).port)
    else server.once('listening', () => resolve((server.address() as AddressInfo).port))
  })

  async function withListener(run: (base: string) => Promise<void>) {
    initRemoteE2EE({ storage, mode: 'required' })
    const app = new Hono()
    app.use('/api/*', createRemoteE2EEMiddleware())
    app.post('/api/echo', async (c) => c.json({ received: await c.req.json(), remote: c.req.header(REMOTE_TUNNEL_HEADER) ?? null }))
    app.route('/api/e2ee', remoteE2EERoutes())
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }) as http.Server
    const port = await listening(server)
    const ingress = createDirectIngress({
      localPort: () => port,
      localToken: () => undefined,
      delegationTunnelToken: 'tunnel-token',
      selfNodeId: () => 'node-test',
      trustedPeer: () => null,
      pairedDevice: (deviceId) => getConfirmedRemoteDeviceKeys(deviceId) !== null,
      e2eeRequired: () => true,
    })
    ingress.listen(0, '127.0.0.1')
    try {
      await run(`http://127.0.0.1:${await listening(ingress)}`)
    } finally {
      for (const each of [ingress, server]) {
        each.closeAllConnections()
        await new Promise((resolve) => each.close(resolve))
      }
    }
  }

  function sealed(method: string, apiPath: string, body?: unknown) {
    const keys = deriveRemoteDirectionKeys(pairing)
    const innerContentType = body === undefined ? '' : 'application/json'
    const aad = requestAad({ method, apiPath, deviceId: pairing.deviceId, keyId: pairing.keyId, innerContentType })
    const envelope = seal(body === undefined ? new Uint8Array() : utf8(JSON.stringify(body)), keys.request, aad)
    const headers: Record<string, string> = {
      [E2EE_HEADER]: 'v1', [E2EE_DEVICE_HEADER]: pairing.deviceId, [E2EE_KEY_HEADER]: pairing.keyId,
      [E2EE_INNER_CONTENT_TYPE_HEADER]: innerContentType,
    }
    if (body === undefined) headers[E2EE_PROOF_HEADER] = encodeEnvelope(envelope)
    else headers['content-type'] = 'application/json'
    return {
      init: { method, headers, ...(body === undefined ? {} : { body: encodeEnvelope(envelope) }) },
      context: responseContext({ method, apiPath, requestNonce: envelope.nonce }),
      async read(response: Response): Promise<unknown> {
        const innerType = response.headers.get(E2EE_INNER_CONTENT_TYPE_HEADER) ?? ''
        const parts = (await response.text()).trim().split('\n').map((line) => {
          const frame = decodeStreamFrame(line)
          return open(frame, keys.response, responseFrameAad({
            deviceId: pairing.deviceId, keyId: pairing.keyId, context: this.context, status: response.status,
            framing: 'ndjson', innerContentType: innerType, seq: frame.seq, final: frame.final,
          }))
        })
        return JSON.parse(new TextDecoder().decode(concat(parts)))
      },
    }
  }

  it('is opened with its pairing key, as through Broker', async () => {
    await withListener(async (base) => {
      const request = sealed('POST', '/api/echo', { secret: 'over tailscale' })
      const response = await fetch(`${base}/api/echo`, request.init)
      expect(response.status).toBe(200)
      expect(response.headers.get(E2EE_CONTEXT_HEADER)).toBe(request.context)
      // The tunnel marker is not handed to ordinary routes, exactly as through Broker.
      expect(await request.read(response)).toEqual({ received: { secret: 'over tailscale' }, remote: null })
    })
  })

  it('still needs encryption: a plain request from a paired device id is refused', async () => {
    await withListener(async (base) => {
      const response = await fetch(`${base}/api/echo`, {
        method: 'POST', headers: { [E2EE_DEVICE_HEADER]: pairing.deviceId, 'content-type': 'application/json' }, body: '{}',
      })
      expect(response.status).toBe(426)
    })
  })

  it('learns the direct address over the sealed channel', async () => {
    await withListener(async (base) => {
      const request = sealed('GET', '/api/e2ee/direct')
      const response = await fetch(`${base}/api/e2ee/direct`, request.init)
      expect(response.status).toBe(200)
      // Not published in this test.
      expect(await request.read(response)).toEqual({ address: null })
    })
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

/**
 * Approving a device is the only local call that mints a persistent,
 * internet-reachable credential, so it does not rest on the api-token gate —
 * which by design does not stop a same-user process. These cover the two
 * barriers that replace it: the nonce, and the closed HTTP route.
 */
describe('device pairing approval', () => {
  /** Drive a pairing to the 'pending' state the Approve button acts on. */
  const claimPairing = (payload: ReturnType<typeof startRemotePairing>) => {
    const device = createDeviceKeypair()
    const claim = {
      deviceId: crypto.randomUUID(),
      deviceName: 'Test phone',
      platform: 'ios' as const,
      devicePublicKey: bytesToBase64(device.publicKey),
      deviceFingerprint: fingerprintPublicKey(device.publicKey),
    }
    const key = derivePairingKey(base64ToBytes(payload.pairingSecret), payload.pairingId)
    claimRemotePairing({
      pairingId: payload.pairingId,
      envelope: seal(utf8(JSON.stringify(claim)), key, pairingAad(payload.pairingId, 'claim')),
    })
    return claim
  }

  it('rejects an approval that does not carry the pairing nonce', () => {
    initRemoteE2EE({ storage, mode: 'required', secureApprovalChannel: true })
    const payload = startRemotePairing()
    claimPairing(payload)

    expect(() => approveRemotePairing(payload.pairingId, 'not-the-nonce')).toThrow(/operon window/)
    expect(() => approveRemotePairing(payload.pairingId, '')).toThrow(/operon window/)
    // Still pending: a failed approval must not be a partial one.
    expect(storage.getMobilePairingByNonce(payload.pairingId)?.status).toBe('pending')
  })

  it('confirms with the nonce and tells the host exactly once', () => {
    const confirmed: string[] = []
    initRemoteE2EE({
      storage,
      mode: 'required',
      secureApprovalChannel: true,
      onPairingConfirmed: (p) => confirmed.push(p.mobileFingerprint),
    })
    const payload = startRemotePairing()
    const claim = claimPairing(payload)

    const summary = approveRemotePairing(payload.pairingId, getPairingApprovalNonce(payload.pairingId)!)
    expect(summary.status).toBe('confirmed')
    expect(confirmed).toEqual([claim.deviceFingerprint])
  })

  it('never exposes the nonce through the pairing payload', () => {
    initRemoteE2EE({ storage, mode: 'required', secureApprovalChannel: true })
    const payload = startRemotePairing()
    const nonce = getPairingApprovalNonce(payload.pairingId)

    expect(nonce).toBeTruthy()
    expect(JSON.stringify(payload)).not.toContain(nonce!)
  })

  it('closes the HTTP approve route when the host has a secure channel', async () => {
    initRemoteE2EE({ storage, mode: 'required', secureApprovalChannel: true })
    const payload = startRemotePairing()
    claimPairing(payload)
    expect(requiresSecureApproval()).toBe(true)

    const app = new Hono()
    app.route('/api/e2ee', remoteE2EERoutes())
    const res = await app.request(`/api/e2ee/pair/session/${payload.pairingId}/approve`, { method: 'POST' })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'approval_requires_desktop_ui' })
    expect(storage.getMobilePairingByNonce(payload.pairingId)?.status).toBe('pending')
  })

  it('keeps the HTTP route usable for headless hosts, which have no better channel', async () => {
    initRemoteE2EE({ storage, mode: 'required', secureApprovalChannel: false })
    const payload = startRemotePairing()
    claimPairing(payload)
    expect(requiresSecureApproval()).toBe(false)

    const app = new Hono()
    app.route('/api/e2ee', remoteE2EERoutes())
    const res = await app.request(`/api/e2ee/pair/session/${payload.pairingId}/approve`, { method: 'POST' })

    expect(res.status).toBe(200)
    expect(storage.getMobilePairingByNonce(payload.pairingId)?.status).toBe('confirmed')
  })
})

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
