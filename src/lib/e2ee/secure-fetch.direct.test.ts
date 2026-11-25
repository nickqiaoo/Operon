import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bytesToBase64, E2EE_DEVICE_HEADER, E2EE_HEADER, type StoredRemotePairing } from '@shared/e2ee/protocol'
import { createDeviceKeypair, fingerprintPublicKey } from '@shared/e2ee/crypto'

/**
 * Which way a sealed request from the phone app goes (remote-route.ts): the
 * machine's direct address over Tailscale when it answers, Broker otherwise.
 * The machine and Broker are stand-ins that record what reached them.
 */

const node = 'b'.repeat(32)
const direct = 'https://mini.tail1234.ts.net:47421'
const broker = 'https://broker.example'
const brokerUrl = (path: string) => `${broker}/u/user-1/n/${node}/api${path}`

// Node's fetch types (jsdom's AbortSignal does not fit them); remote-route keeps its state here.
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value) },
  removeItem: (key: string) => { store.delete(key) },
  clear: () => store.clear(),
})

const pairing = vi.hoisted(() => ({ value: null as StoredRemotePairing | null }))
vi.mock('./device-store', () => ({
  getRemotePairing: async () => pairing.value,
  removeRemotePairing: async () => undefined,
}))

const { secureBrokerFetch } = await import('./secure-fetch')
const {
  clearRouteProbe, clientRouteStatus, directOnlyNodeBaseUrl, listLocalMachines, rememberLocalMachine, remoteRouteTestUtils, saveDirectAddress,
  setAccountless, setRouteMode,
} = await import('../remote-route')

interface Sent { url: string; method: string; headers: Headers; body: string }
let sent: Sent[]
/** How the direct address behaves: answering, unreachable, or turning requests away unread. */
let machine: 'up' | 'down' | 'turns-away'
let pinged: number

const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.origin === direct) {
    if (url.pathname === '/direct/ping') {
      pinged += 1
      if (machine === 'down') throw new TypeError('Load failed')
      return Response.json({ v: 1, nodeId: node })
    }
    if (machine === 'down') throw new TypeError('Load failed')
  }
  sent.push({ url: request.url, method: request.method, headers: request.headers, body: await request.text() })
  if (url.origin === direct && machine === 'turns-away') {
    return Response.json({ error: 'direct_unavailable', message: 'Direct connections need end-to-end encryption' }, { status: 503 })
  }
  // Neither stand-in seals answers; an unencrypted error is handed back as is.
  return Response.json({ error: 'not_found' }, { status: 404 })
})

const call = (path: string, init?: RequestInit) =>
  secureBrokerFetch(fetchImpl as typeof fetch, brokerUrl(path), { ...init, headers: { authorization: 'Bearer broker-token', ...init?.headers } })

beforeEach(() => {
  const device = createDeviceKeypair()
  const machineKeys = createDeviceKeypair()
  pairing.value = {
    v: 1, nodeId: node, desktopId: 'desk', deviceId: 'phone-1', pairedAt: 1,
    nodePublicKey: bytesToBase64(machineKeys.publicKey), nodeFingerprint: fingerprintPublicKey(machineKeys.publicKey),
    devicePrivateKey: bytesToBase64(device.privateKey), devicePublicKey: bytesToBase64(device.publicKey),
    keyId: fingerprintPublicKey(device.publicKey),
  }
  sent = []
  machine = 'up'
  pinged = 0
  fetchImpl.mockClear()
  localStorage.clear()
  remoteRouteTestUtils.reset()
})

afterEach(() => localStorage.clear())

describe('the route a sealed request takes', () => {
  it('goes through Broker while the machine has shared no address', async () => {
    await call('/fs/read?path=a')
    expect(sent.map((s) => s.url)).toEqual([brokerUrl('/fs/read?path=a')])
    expect(pinged).toBe(0)
  })

  it('goes straight to the machine once its address answers, sealed, without the Broker token', async () => {
    saveDirectAddress(node, direct)
    await call('/fs/read?path=a')
    expect(sent.map((s) => s.url)).toEqual([`${direct}/api/fs/read?path=a`])
    expect(sent[0].headers.get(E2EE_HEADER)).toBe('v1')
    expect(sent[0].headers.get(E2EE_DEVICE_HEADER)).toBe('phone-1')
    expect(sent[0].headers.get('authorization')).toBeNull()
    expect(await clientRouteStatus(fetchImpl as typeof fetch, node)).toMatchObject({ mode: 'auto', address: direct, route: 'direct' })
  })

  it('checks again on resume even when the previous failure is still cached', async () => {
    saveDirectAddress(node, direct)
    machine = 'down'
    await call('/fs/read')
    machine = 'up'
    clearRouteProbe(node)
    expect(await clientRouteStatus(fetchImpl, node, true)).toMatchObject({ route: 'direct' })
    expect(pinged).toBe(2)
  })

  it('ignores an address that is not HTTPS on a MagicDNS name', async () => {
    saveDirectAddress(node, 'http://192.168.1.20:47420')
    saveDirectAddress(node, 'http://100.100.0.2:47420')
    await call('/fs/read')
    expect(sent.map((s) => new URL(s.url).origin)).toEqual([broker])
  })

  it('goes through Broker when the address does not answer', async () => {
    saveDirectAddress(node, direct)
    machine = 'down'
    await call('/fs/read')
    expect(sent.map((s) => new URL(s.url).origin)).toEqual([broker])
    expect(await clientRouteStatus(fetchImpl as typeof fetch, node)).toMatchObject({ route: 'broker', error: expect.any(String) })
  })

  it('sends a request the direct listener turned away through Broker, body and all', async () => {
    saveDirectAddress(node, direct)
    machine = 'turns-away'
    await call('/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"hi"}' })
    expect(sent.map((s) => new URL(s.url).origin)).toEqual([new URL(direct).origin, broker])
    // Sealed twice, so the second is not a replay of the first.
    expect(JSON.parse(sent[0].body).nonce).not.toBe(JSON.parse(sent[1].body).nonce)
    expect(sent[1].headers.get('authorization')).toBe('Bearer broker-token')
  })

  it('sends a read again through Broker when the connection fails, but never a write', async () => {
    saveDirectAddress(node, direct)
    await call('/fs/read') // the address answers: trusted for a while
    machine = 'down'
    sent = []
    await call('/fs/read')
    expect(sent.map((s) => new URL(s.url).origin)).toEqual([broker])

    remoteRouteTestUtils.reset()
    machine = 'up'
    await call('/fs/read')
    machine = 'down'
    sent = []
    await expect(call('/fs/write', { method: 'POST', body: '{}' })).rejects.toThrow()
    expect(sent).toHaveLength(0)
  })

  it('set to Direct only, answers that it cannot reach the machine instead of using Broker', async () => {
    setRouteMode(node, 'direct')
    machine = 'down'
    saveDirectAddress(node, direct)
    const res = await call('/fs/read')
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'direct_unreachable' })
    expect(sent).toHaveLength(0)
  })

  it('set to Broker only, never tries the address', async () => {
    setRouteMode(node, 'broker')
    saveDirectAddress(node, direct)
    await call('/fs/read')
    expect(sent.map((s) => new URL(s.url).origin)).toEqual([broker])
    expect(pinged).toBe(0)
  })
})

describe('without an account', () => {
  const callDirectOnly = (path: string, init?: RequestInit) =>
    secureBrokerFetch(fetchImpl as typeof fetch, `${directOnlyNodeBaseUrl(node)}${path}`, init)

  beforeEach(() => {
    setAccountless(true)
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
  })

  it('sends the stand-in Broker URL straight to the machine', async () => {
    saveDirectAddress(node, direct)
    await callDirectOnly('/fs/read?path=a')
    expect(sent.map((s) => s.url)).toEqual([`${direct}/api/fs/read?path=a`])
  })

  it('has no Broker to fall back on, whatever the mode says', async () => {
    setRouteMode(node, 'broker')
    saveDirectAddress(node, direct)
    machine = 'down'
    const res = await callDirectOnly('/fs/read')
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'direct_unreachable' })
    expect(sent).toHaveLength(0)
  })

  it('asks to pair, without sending anything, for a machine it has no key for', async () => {
    pairing.value = null
    const res = await callDirectOnly('/fs/read')
    expect(res.status).toBe(426)
    expect(sent).toHaveLength(0)
  })

  it('keeps the machines it paired with', () => {
    rememberLocalMachine({ nodeId: node, label: 'Mini' })
    rememberLocalMachine({ nodeId: node, label: 'Mac mini' })
    expect(listLocalMachines()).toEqual([{ nodeId: node, label: 'Mac mini' }])
  })
})
