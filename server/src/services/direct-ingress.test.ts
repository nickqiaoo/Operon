import http, { type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { DIRECT_PING_PATH } from '@shared/delegations'
import { E2EE_DEVICE_HEADER, PAIRING_HEADER } from '@shared/e2ee/protocol'
import { createDirectIngress, type DirectIngressOptions } from './direct-ingress.js'

const self = 'a'.repeat(32)
const peer = 'b'.repeat(32)
const stranger = 'c'.repeat(32)
const phone = '7f1c2b8e-1d2a-4c55-9a0e-3b6d1f0a9c11'

/** Stands in for this machine's server: records what reached it. */
let local: http.Server
let wss: WebSocketServer
let ingress: http.Server
let received: Array<{ url: string; headers: IncomingHttpHeaders; body: string }>
let upgraded: IncomingHttpHeaders[]
let aborted: string[]
const settings = { e2ee: true }

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
}

let base: string

async function start(overrides: Partial<DirectIngressOptions> = {}) {
  const localPort = await listen(local)
  ingress = createDirectIngress({
    localPort: () => localPort,
    localToken: () => 'local-token',
    delegationTunnelToken: 'tunnel-token',
    selfNodeId: () => self,
    trustedPeer: (nodeId) => (nodeId === peer ? { label: 'Peer Mac' } : null),
    pairedDevice: (deviceId) => deviceId === phone,
    e2eeRequired: () => settings.e2ee,
    ...overrides,
  })
  base = `http://127.0.0.1:${await listen(ingress)}`
}

beforeEach(() => {
  received = []
  upgraded = []
  aborted = []
  settings.e2ee = true
  wss = new WebSocketServer({ noServer: true })
  local = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      received.push({ url: req.url ?? '', headers: req.headers, body })
      if (req.url === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: one\n\n')
        // Leave an event half sent, then finish it: no keepalive may land inside it.
        setTimeout(() => res.write('data: tw'), 40)
        setTimeout(() => res.end('o\n\n'), 160)
        return
      }
      if (req.url === '/api/hang') {
        res.on('close', () => aborted.push(req.url ?? ''))
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: start\n\n')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  local.on('upgrade', (req, socket, head) => {
    upgraded.push(req.headers)
    wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (data) => ws.send(`echo:${String(data)}`)))
  })
})

afterEach(async () => {
  wss.close()
  ingress?.closeAllConnections()
  local.closeAllConnections()
  await Promise.all([ingress, local].map((server) => new Promise((resolve) => server?.close(resolve))))
})

const fromPeer = { [E2EE_DEVICE_HEADER]: peer }

describe('the direct listener', () => {
  it('answers a ping with which machine this is, unauthenticated', async () => {
    await start()
    const res = await fetch(`${base}${DIRECT_PING_PATH}`)
    expect(await res.json()).toEqual({ v: 1, nodeId: self })
    expect(received).toHaveLength(0)
  })

  it('stamps a paired machine\'s request the way the tunnel agent does, and drops what the caller forged', async () => {
    await start()
    const res = await fetch(`${base}/api/fs/read?path=x`, {
      method: 'POST',
      headers: {
        ...fromPeer,
        'content-type': 'application/json',
        'x-operon-remote-tunnel': '0',
        'x-operon-token': 'guessed',
        'x-operon-delegation-tunnel': 'guessed',
        'x-operon-delegation-source': stranger,
        'x-operon-delegation-source-label': 'forged',
        'x-operon-origin': 'webhook',
        'x-operon-webhook-event': 'forged',
        authorization: 'Bearer forged',
      },
      body: '{"sealed":true}',
    })
    expect(res.status).toBe(200)
    const [got] = received
    expect(got.url).toBe('/api/fs/read?path=x')
    expect(got.body).toBe('{"sealed":true}')
    expect(got.headers).toMatchObject({
      'x-operon-remote-tunnel': '1',
      'x-operon-token': 'local-token',
      'x-operon-delegation-tunnel': 'tunnel-token',
      'x-operon-delegation-source': peer,
      'x-operon-delegation-source-label': Buffer.from('Peer Mac').toString('base64'),
      'x-operon-device-id': peer,
    })
    expect(got.headers['x-operon-origin']).toBeUndefined()
    expect(got.headers['x-operon-webhook-event']).toBeUndefined()
    expect(got.headers.authorization).toBeUndefined()
  })

  it('lets only machines this one trusts, and devices paired with it, through', async () => {
    await start()
    const attempts: Array<[Record<string, string>, string]> = [
      [{}, 'direct_device_unknown'],
      [{ [E2EE_DEVICE_HEADER]: stranger }, 'machine_not_paired'],
      [{ [E2EE_DEVICE_HEADER]: self }, 'direct_device_unknown'],
      // Not the code a client drops its pairing on.
      [{ [E2EE_DEVICE_HEADER]: 'phone-uuid' }, 'direct_device_unknown'],
    ]
    for (const [headers, error] of attempts) {
      const res = await fetch(`${base}/api/chat`, { headers })
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ error })
    }
    expect(received).toHaveLength(0)
  })

  it('passes a paired phone on unstamped, as Broker does, with what it forged dropped', async () => {
    await start()
    const res = await fetch(`${base}/api/chat`, {
      headers: {
        [E2EE_DEVICE_HEADER]: phone,
        'x-operon-delegation-source': peer,
        'x-operon-delegation-tunnel': 'guessed',
        'tailscale-user-login': 'someone@example.com',
      },
    })
    expect(res.status).toBe(200)
    const [got] = received
    expect(got.headers).toMatchObject({ 'x-operon-remote-tunnel': '1', 'x-operon-token': 'local-token', [E2EE_DEVICE_HEADER.toLowerCase()]: phone })
    expect(got.headers['x-operon-delegation-source']).toBeUndefined()
    expect(got.headers['x-operon-delegation-tunnel']).toBeUndefined()
    expect(got.headers['tailscale-user-login']).toBeUndefined()
  })

  it('lets only pairing claims through unpaired, and keeps every other pairing route local', async () => {
    await start()
    const pairing = { [PAIRING_HEADER]: 'v1' }
    // A phone without Broker: its claim and status poll, sealed under the QR code.
    expect((await fetch(`${base}/api/e2ee/pair/claim`, { method: 'POST', headers: pairing, body: '{}' })).status).toBe(200)
    expect((await fetch(`${base}/api/e2ee/pair/status/abc`, { headers: pairing })).status).toBe(200)
    expect(received.map((r) => [r.url, r.headers['x-operon-pairing'], r.headers['x-operon-delegation-source']]))
      .toEqual([['/api/e2ee/pair/claim', 'v1', undefined], ['/api/e2ee/pair/status/abc', 'v1', undefined]])
    // A machine without Broker: the claim only, stamped with who it says it is.
    expect((await fetch(`${base}/api/delegations/pair/claim`, { method: 'POST', headers: { [E2EE_DEVICE_HEADER]: stranger }, body: '{}' })).status).toBe(200)
    expect(received[2].headers['x-operon-delegation-source']).toBe(stranger)
    received = []
    // Everything else.
    const fromPhone = { [E2EE_DEVICE_HEADER]: phone }
    expect((await fetch(`${base}/api/e2ee/pair/start`, { method: 'POST', headers: pairing, body: '{}' })).status).toBe(403)
    expect((await fetch(`${base}/api/e2ee/pair/session/x/approve`, { method: 'POST', headers: pairing, body: '{}' })).status).toBe(403)
    expect((await fetch(`${base}/api/e2ee/pair/claim`, { method: 'POST', headers: fromPhone, body: '{}' })).status).toBe(403)
    expect((await fetch(`${base}/api/anything`, { headers: { ...fromPhone, ...pairing } })).status).toBe(403)
    expect((await fetch(`${base}/api/e2ee/pair/claim`, { method: 'POST', headers: { [PAIRING_HEADER]: 'v0' }, body: '{}' })).status).toBe(400)
    expect((await fetch(`${base}/api/delegations/agents`, { method: 'POST', headers: { [E2EE_DEVICE_HEADER]: stranger }, body: '{}' })).status).toBe(403)
    expect(received).toHaveLength(0)
  })

  it('answers the phone app\'s preflight and lets it read the encrypted headers', async () => {
    await start()
    const preflight = await fetch(`${base}/api/chat`, {
      method: 'OPTIONS',
      headers: { origin: 'capacitor://localhost', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-operon-e2ee,content-type' },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('capacitor://localhost')
    expect(preflight.headers.get('access-control-allow-headers')).toBe('x-operon-e2ee,content-type')
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull()
    const res = await fetch(`${base}/api/chat`, { headers: { origin: 'capacitor://localhost', [E2EE_DEVICE_HEADER]: phone } })
    expect(res.headers.get('access-control-allow-origin')).toBe('capacitor://localhost')
    expect(res.headers.get('access-control-expose-headers')).toContain('X-Operon-E2EE-Context')
    expect(received).toHaveLength(1)
  })

  it('never passes on Broker\'s webhook deliveries or anything outside the API', async () => {
    await start()
    expect((await fetch(`${base}/api/integrations/events/linear`, { method: 'POST', headers: fromPeer, body: '{}' })).status).toBe(403)
    expect((await fetch(`${base}/API/Integrations/events/github`, { method: 'POST', headers: fromPeer, body: '{}' })).status).toBe(404)
    expect((await fetch(`${base}/index.html`, { headers: fromPeer })).status).toBe(404)
    expect(received).toHaveLength(0)
  })

  it('refuses everything while remote requests may be unencrypted', async () => {
    settings.e2ee = false
    await start()
    const res = await fetch(`${base}/api/chat`, { headers: fromPeer })
    expect(res.status).toBe(503)
    expect(received).toHaveLength(0)
  })

  it('keeps a quiet event stream alive, only between events', async () => {
    await start({ sseKeepaliveMs: 25 })
    const res = await fetch(`${base}/api/stream`, { headers: fromPeer })
    const text = await res.text()
    expect(text).toContain(': keepalive\n\n')
    // The half-sent event arrives whole: nothing was spliced into it.
    expect(text).toContain('data: two\n\n')
    expect(text.replace(/: keepalive\n\n/g, '')).toBe('data: one\n\ndata: two\n\n')
  })

  it('stops the work when the caller goes away', async () => {
    await start()
    const controller = new AbortController()
    const res = await fetch(`${base}/api/hang`, { headers: fromPeer, signal: controller.signal })
    const reader = res.body!.getReader()
    await reader.read()
    controller.abort()
    await expect.poll(() => aborted).toEqual(['/api/hang'])
  })

  it('carries a paired machine\'s terminal socket, stamped, and refuses a stranger\'s', async () => {
    await start()
    const socket = new WebSocket(`${base.replace('http', 'ws')}/api/terminal/ws?e2ee=v1&deviceId=${peer}&keyId=k`)
    const reply = await new Promise<string>((resolve, reject) => {
      socket.on('open', () => socket.send('hi'))
      socket.on('message', (data) => resolve(String(data)))
      socket.on('error', reject)
    })
    socket.close()
    expect(reply).toBe('echo:hi')
    expect(upgraded[0]).toMatchObject({
      'x-operon-remote-tunnel': '1',
      'x-operon-delegation-source': peer,
      'x-operon-delegation-tunnel': 'tunnel-token',
      'x-operon-token': 'local-token',
    })

    const refused = new WebSocket(`${base.replace('http', 'ws')}/api/terminal/ws?deviceId=${stranger}`)
    const status = await new Promise<number>((resolve) => {
      refused.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      refused.on('error', () => resolve(-1))
    })
    expect(status).toBe(403)
    expect(upgraded).toHaveLength(1)
  })
})
