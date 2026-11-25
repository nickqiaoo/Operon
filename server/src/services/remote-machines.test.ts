import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { NodeWebSocket } from '@hono/node-ws'
import {
  DELEGATION_PUBLIC_KEY_HEADER, DELEGATION_SOURCE_HEADER, DELEGATION_SOURCE_LABEL_HEADER, DELEGATION_TUNNEL_HEADER,
  REMOTE_TUNNEL_HEADER, bytesToBase64,
} from '@shared/e2ee/protocol'
import { createDeviceKeypair, fingerprintPublicKey } from '@shared/e2ee/crypto'
import { DELEGATED_AGENT_EVENTS_PATH, MACHINE_PEER_SYNC_PATH, type DelegatedAgentStarted } from '@shared/delegations'
import { SqliteStorage } from '../storage/sqlite.js'
import { delegationRoutes } from '../routes/delegations.js'
import { remoteMachineRoutes } from '../routes/remote-machines.js'
import { createRemoteE2EEMiddleware, initRemoteE2EE } from './remote-e2ee.js'
import { delegationTunnelToken } from './delegation-tunnel.js'
import { DelegationHost } from './delegation-host.js'
import { initRemoteAgents, listRemoteAgents, reportToParentMachine, startRemoteAgent } from './remote-agents.js'
import { delegationRequest } from './delegation-transport.js'
import { initMachinePeers, pinPairedPeer, revokePeer } from './machine-peers.js'
import { joinWithPairingCode, machinePairingTestUtils, receivePeerSync, startPairingCode } from './machine-pairing.js'
import type { AddressInfo } from 'node:net'
import type http from 'node:http'
import { serve } from '@hono/node-server'
import { createDirectIngress } from './direct-ingress.js'
import {
  directLinkTestUtils, discoverMachines, getDirectLinkStatus, initDirectLink, setBrokerEnabled, setDirectLinkSettings, setPeerMode,
} from './direct-link.js'
import { isTrustedPeer } from './machine-peers.js'

/**
 * Two machines of one account in one process: the origin (whose UI and
 * conversations start things) and the target, joined by a stand-in for Broker
 * that authenticates by node, routes, and stamps the source machine and the key
 * it registered — with the real end-to-end encryption in between.
 *
 * Both share one database, so its machine_peers holds both sides' records: the
 * origin's of the target and the target's of the origin.
 */

const origin = 'a'.repeat(32)
const target = 'b'.repeat(32)
const account = 'd'.repeat(32)
const onTarget = new AsyncLocalStorage<boolean>()
const keys = { [origin]: createDeviceKeypair(), [target]: createDeviceKeypair() }
/** Broker's own key, which a dishonest Broker would stamp in place of a machine's. */
const brokerKey = createDeviceKeypair()
const here = () => (onTarget.getStore() ? target : origin)

const delivered = vi.hoisted(() => ({ results: [] as Array<{ chatId: number; id: string; text: string }> }))

vi.mock('../gateway/saas/config.js', () => ({
  getSaasConfig: () => ({ nodeId: here(), nodeToken: `token-${here()}`, userId: account, label: here() === origin ? 'Origin' : 'Target' }),
}))
vi.mock('./mobile/identity.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./mobile/identity.js')>(),
  getDelegationKeypair: () => ({ ...keys[here()], fingerprint: fingerprintPublicKey(keys[here()].publicKey) }),
}))
// No real Tailscale client is asked; the direct tests stand one in.
const tailnetDevices = vi.hoisted(() => ({ list: [] as Array<{ ipv4: string }> }))
vi.mock('./tailscale.js', () => ({
  detectTailscale: async () => ({ state: 'stopped' }),
  tailnetPeers: () => tailnetDevices.list,
  readServe: async () => null,
}))
vi.mock('./external-agent-notifications.js', () => ({
  enqueueExternalAgentResult: (chatId: number, message: { id: string; parts: Array<{ text: string }> }) => {
    delivered.results.push({ chatId, id: message.id, text: message.parts[0].text })
  },
}))

let root: string
let storage: SqliteStorage
let stopRemoteAgents: () => void
/** Which machines answer at all (an offline one gets Broker's 503). */
const online = { [origin]: true, [target]: true }
const accepting = { [origin]: false, [target]: true }
const seen: Array<{ path: string; search: string; body: string; token: string | null }> = []
const created: unknown[] = []

function machineApp(nodeId: string, routes: (app: Hono) => void): Hono {
  const app = new Hono()
  app.use('/api/*', createRemoteE2EEMiddleware({
    acceptsMachines: () => accepting[nodeId],
    alwaysFromMachines: (p) => p === DELEGATED_AGENT_EVENTS_PATH || p === MACHINE_PEER_SYNC_PATH,
  }))
  routes(app)
  return app
}

let apps: Record<string, Hono>
/** What the stand-in Broker forwarded, to replay. */
const forwarded: Array<{ to: string; url: string; init: RequestInit; headers: Headers }> = []
/** A dishonest Broker: stamps its own key as the source machine's. */
const broker = { stampOwnKey: false }
/** Tailnet addresses the direct tests answer on, mapped to where their listener really is. */
const tailnet = new Map<string, string>()
let releaseQuiet: (() => void) | undefined
const realFetch = globalThis.fetch

function pairBoth() {
  pinPairedPeer({ nodeId: target, publicKey: keys[target].publicKey, label: 'Target' })
  pinPairedPeer({ nodeId: origin, publicKey: keys[origin].publicKey, label: 'Origin' })
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'operon-remote-machines-'))
  storage = new SqliteStorage(path.join(root, 'test.sqlite'))
  initRemoteE2EE({ storage, mode: 'required' })
  initMachinePeers(storage)
  pairBoth()
  stopRemoteAgents = initRemoteAgents(storage)
  forwarded.length = 0
  broker.stampOwnKey = false
  delivered.results.length = 0
  seen.length = 0
  created.length = 0
  online[origin] = online[target] = true
  accepting[origin] = false
  accepting[target] = true

  apps = {
    [origin]: machineApp(origin, (app) => {
      app.route('/api/remote', remoteMachineRoutes((() => () => undefined) as unknown as NodeWebSocket['upgradeWebSocket']))
      app.route('/api/delegations', delegationRoutes(new DelegationHost(storage)))
    }),
    [target]: machineApp(target, (app) => {
      app.all('/api/echo/*', async (c) => {
        const url = new URL(c.req.url)
        const body = c.req.method === 'GET' ? '' : await c.req.text()
        seen.push({ path: url.pathname, search: url.search, body, token: url.searchParams.get('token') })
        return c.json({ method: c.req.method, path: url.pathname, body, type: c.req.header('content-type') ?? null }, 201, { 'X-Chat-Id': '7' })
      })
      app.get('/api/stream', (c) => streamSSE(c, async (stream) => {
        for (const n of [1, 2, 3]) await stream.writeSSE({ data: String(n) })
      }))
      // One event, then quiet until the test lets it end.
      app.get('/api/quiet', (c) => streamSSE(c, async (stream) => {
        await stream.writeSSE({ data: 'first' })
        await new Promise<void>((resolve) => { releaseQuiet = resolve })
      }))
      app.get('/api/delegations/catalog', (c) => c.json({ agents: [{ agentType: 'codex' }], workspaces: [{ id: 4, name: 'main', project: 'Repo' }] }))
      app.post('/api/delegations/agents', async (c) => {
        created.push(await c.req.json())
        const started: DelegatedAgentStarted = { childChatId: 31, workspaceId: 4, providerId: 'codex', modelId: 'gpt', turnId: 'turn-1', status: 'running' }
        return c.json(started)
      })
    }),
  }

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const direct = tailnet.get(url.origin)
    if (direct !== undefined) return realFetch(`${direct}${url.pathname}${url.search}`, init)
    if (url.pathname === '/agent/delegation-nodes') {
      return Response.json([{ nodeId: origin, label: 'Origin', online: online[origin] }, { nodeId: target, label: 'Target', online: online[target] }])
    }
    const to = /\/n\/([0-9a-f]{32})\//.exec(url.pathname)?.[1] ?? ''
    if (!online[to]) return Response.json({ error: 'node_offline' }, { status: 503 })
    const from = here()
    const headers = new Headers(init?.headers)
    headers.delete('authorization')
    headers.set(REMOTE_TUNNEL_HEADER, '1')
    headers.set(DELEGATION_TUNNEL_HEADER, delegationTunnelToken)
    headers.set(DELEGATION_SOURCE_HEADER, from)
    headers.set(DELEGATION_SOURCE_LABEL_HEADER, bytesToBase64(new TextEncoder().encode(from === origin ? 'Origin' : 'Target')))
    headers.set(DELEGATION_PUBLIC_KEY_HEADER, bytesToBase64((broker.stampOwnKey ? brokerKey : keys[from]).publicKey))
    const apiPath = url.pathname.slice(url.pathname.indexOf('/api/'))
    forwarded.push({ to, url: `${apiPath}${url.search}`, init: init ?? {}, headers })
    return onTarget.run(to === target, () => apps[to].request(`${apiPath}${url.search}`, { ...init, headers }))
  }))
})

afterEach(() => {
  machinePairingTestUtils.reset()
  stopRemoteAgents()
  vi.unstubAllGlobals()
  storage.close()
  rmSync(root, { recursive: true, force: true })
})

const relay = (pathAndQuery: string, init?: RequestInit) => apps[origin].request(`/api/remote/${target}${pathAndQuery}`, init)

describe('another machine as this one\'s server (/api/remote)', () => {
  it('replays the request there and answers with its response', async () => {
    const res = await relay('/echo/a?x=1&token=local-secret', {
      method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'hello',
    })
    expect(res.status).toBe(201)
    expect(res.headers.get('x-chat-id')).toBe('7')
    expect(await res.json()).toEqual({ method: 'PUT', path: '/api/echo/a', body: 'hello', type: 'text/plain' })
    // This machine's own token never leaves it.
    expect(seen[0]).toMatchObject({ search: '?x=1', token: null })
  })

  it('keeps a stream a stream', async () => {
    const res = await relay('/stream')
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(await res.text()).toBe('data: 1\n\ndata: 2\n\ndata: 3\n\n')
  })

  it('is refused while the other machine does not serve others, and never reaches who-may-reach-it settings', async () => {
    accepting[target] = false
    expect((await relay('/echo/a')).status).toBe(403)
    accepting[target] = true
    expect((await relay('/e2ee/devices')).status).toBe(403)
    expect(seen).toHaveLength(0)
  })

  it('does not relay on for a caller that came through the tunnel itself', async () => {
    // Unencrypted: refused by the E2EE gate before the route (426).
    expect((await relay('/echo/a', { headers: { [REMOTE_TUNNEL_HEADER]: '1' } })).status).toBe(426)
    expect(seen).toHaveLength(0)
    // Encrypted, from another machine: refused too (it may not use this one's relay).
    await expect(onTarget.run(true, () => delegationRequest(origin, `/api/remote/${target}/echo/a`)))
      .rejects.toMatchObject({ status: 403 })
    expect(seen).toHaveLength(0)
  })
})

describe('an external agent started on another machine', () => {
  const start = () => startRemoteAgent({
    parentChatId: 12, nodeId: target, providerId: 'codex', model: 'gpt', description: 'Fix it', prompt: 'Fix the bug',
  })

  it('is created there, recorded here, and reports its turns back once', async () => {
    const result = await start()
    expect(created[0]).toEqual({ parentChatId: 12, providerId: 'codex', model: 'gpt', description: 'Fix it', prompt: 'Fix the bug', workspaceId: 4 })
    expect(result).toMatchObject({ agent_id: `ext-r${target.slice(0, 8)}-31`, chat_id: 31, machine: 'Target', workspace: 'Repo / main' })
    expect(listRemoteAgents(12)[0]).toMatchObject({ childChatId: 31, status: 'running', remote: { nodeId: target, machine: 'Target' } })

    await onTarget.run(true, async () => {
      reportToParentMachine({ nodeId: origin, chatId: 12 }, {
        type: 'settings', eventId: crypto.randomUUID(), childChatId: 31, modelId: 'other-model', effort: 'high',
      })
      await vi.waitFor(() => expect(listRemoteAgents(12)[0]).toMatchObject({
        modelId: 'other-model', effort: 'high', status: 'running',
      }))
    })

    // The target reports a result. This machine serves no others, but takes this.
    const event = { type: 'result', childChatId: 31, turnId: 'turn-1', status: 'completed', dispatched: true, prompt: 'Fix the bug', result: 'Fixed.' } as const
    await onTarget.run(true, async () => {
      reportToParentMachine({ nodeId: origin, chatId: 12 }, event)
      await vi.waitFor(() => expect(delivered.results).toHaveLength(1))
      // A retried delivery of the same turn is not a second result.
      reportToParentMachine({ nodeId: origin, chatId: 12 }, event)
      await vi.waitFor(() => expect(storage.get('remote-agents:outbox')).toEqual([]))
    })
    expect(delivered.results).toHaveLength(1)
    expect(delivered.results[0]).toMatchObject({ chatId: 12 })
    expect(delivered.results[0].text).toContain(`<agent-id>ext-r${target.slice(0, 8)}-31</agent-id>`)
    expect(delivered.results[0].text).toContain('<machine>Target</machine>')
    expect(delivered.results[0].text).toContain('<result>Fixed.</result>')
    expect(listRemoteAgents(12)[0]).toMatchObject({ status: 'completed' })
  })

  it('refuses events for an agent this machine did not start there', async () => {
    await start()
    const res = await onTarget.run(true, () => fetch(`https://broker/u/${account}/n/${origin}${DELEGATED_AGENT_EVENTS_PATH}`, {
      method: 'POST', body: '{}',
    }))
    // Not encrypted by a machine key: refused before the route.
    expect(res.status).toBeGreaterThanOrEqual(400)
    await onTarget.run(true, async () => {
      reportToParentMachine({ nodeId: origin, chatId: 12 }, { type: 'turn', childChatId: 99, turnId: 'x', status: 'running' })
      // 404 from the origin: nothing will ever take it, so it is dropped rather than retried.
      await vi.waitFor(() => expect(storage.get('remote-agents:outbox')).toEqual([]))
    })
    expect(delivered.results).toHaveLength(0)
  })

  it('keeps a result for an origin that is offline, and delivers it once it is back', async () => {
    await start()
    online[origin] = false
    await onTarget.run(true, async () => {
      reportToParentMachine({ nodeId: origin, chatId: 12 }, {
        type: 'result', childChatId: 31, turnId: 'turn-1', status: 'failed', error: 'boom', dispatched: true, prompt: 'p', result: '',
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(storage.get<unknown[]>('remote-agents:outbox')).toHaveLength(1)
      online[origin] = true
      // The next round (every 30s in the app) takes it; any report triggers one too.
      reportToParentMachine({ nodeId: origin, chatId: 12 }, { type: 'turn', childChatId: 31, turnId: 'turn-2', status: 'running' })
      await vi.waitFor(() => expect(storage.get('remote-agents:outbox')).toEqual([]))
    })
    expect(delivered.results).toHaveLength(1)
    expect(delivered.results[0].text).toContain('<result>boom</result>')
    // Delivered in order: the failed turn, then the next one starting.
    expect(listRemoteAgents(12)[0]).toMatchObject({ turnId: 'turn-2', status: 'running' })
  })
})

describe('pairing between machines', () => {
  /** Neither side trusts the other (revoked looks the same as never paired). */
  const clearPeers = () => {
    revokePeer(target)
    revokePeer(origin)
  }

  it('keeps machines that never paired apart, whatever Broker says', async () => {
    clearPeers()
    const res = await relay('/echo/a')
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'machine_not_paired' })
    // The target refuses too, even when the origin trusts it: Broker's stamped key counts for nothing.
    pinPairedPeer({ nodeId: target, publicKey: keys[target].publicKey, label: 'Target' })
    expect((await relay('/echo/a')).status).toBe(403)
    expect(seen).toHaveLength(0)
  })

  it('pairs two machines with a code shown on one and entered on the other', async () => {
    clearPeers()
    const { code } = startPairingCode()
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/)
    const peer = await onTarget.run(true, () => joinWithPairingCode(code.toLowerCase().replace(/-/g, ' ')))
    expect(peer).toMatchObject({ nodeId: origin, status: 'trusted', source: 'paired' })
    // The pairing went through Broker without the code: only its derived id and ciphertext.
    const claim = forwarded.find((f) => f.url === '/api/delegations/pair/claim')
    expect(String(claim?.init.body)).not.toContain(code.replace(/-/g, ''))
    expect((await relay('/echo/a', { method: 'POST', body: 'hi' })).status).toBe(201)
    // Single use.
    await expect(onTarget.run(true, () => joinWithPairingCode(code))).rejects.toMatchObject({ status: 404 })
  })

  it('finds no machine for a wrong code', async () => {
    clearPeers()
    startPairingCode()
    await expect(onTarget.run(true, () => joinWithPairingCode('0000-0000-0000-0000'))).rejects.toMatchObject({ status: 404 })
    await expect(onTarget.run(true, () => joinWithPairingCode('not a code'))).rejects.toMatchObject({ status: 400 })
  })

  it('ignores the key a dishonest Broker stamps on a request', async () => {
    broker.stampOwnKey = true
    // The honest machines still talk: the stamp is not what they trust.
    expect((await relay('/echo/a')).status).toBe(201)
    // Broker sealing a request of its own as the origin, with its key, is refused.
    const res = await apps[target].request('/api/echo/forged', {
      method: 'GET',
      headers: {
        [REMOTE_TUNNEL_HEADER]: '1', [DELEGATION_TUNNEL_HEADER]: delegationTunnelToken, [DELEGATION_SOURCE_HEADER]: origin,
        [DELEGATION_PUBLIC_KEY_HEADER]: bytesToBase64(brokerKey.publicKey),
        'X-Operon-E2EE': 'v1', 'X-Operon-Device-Id': origin, 'X-Operon-Key-Id': fingerprintPublicKey(brokerKey.publicKey),
        'X-Operon-E2EE-Time': String(Date.now()), 'X-Operon-E2EE-Proof': '{"v":1,"nonce":"AAAA","ciphertext":"AAAA"}',
      },
    })
    expect(res.status).toBe(403)
    expect(seen.map((s) => s.path)).toEqual(['/api/echo/a'])
  })

  it('refuses a request Broker recorded and sends again', async () => {
    expect((await relay('/echo/a', { method: 'POST', body: 'once' })).status).toBe(201)
    const sent = forwarded.find((f) => f.to === target)!
    const again = await onTarget.run(true, () => apps[target].request(sent.url, { ...sent.init, headers: sent.headers }))
    expect(again.status).toBe(401)
    expect(await again.json()).toMatchObject({ error: 'e2ee_replayed' })
    expect(seen).toHaveLength(1)
  })

  it('stops reaching a machine once it is revoked', async () => {
    expect((await relay('/echo/a')).status).toBe(201)
    revokePeer(target)
    expect((await relay('/echo/a')).status).toBe(403)
    expect(seen).toHaveLength(1)
  })
})

describe('directly over Tailscale', () => {
  const address = 'http://100.100.0.2:47420'
  let targetServer: http.Server
  let ingress: http.Server
  let ingressBase: string
  /** Whether the target requires E2EE, as its direct listener sees it. */
  let targetE2EE = true

  const listening = (server: http.Server) => new Promise<number>((resolve) => {
    if (server.listening) resolve((server.address() as AddressInfo).port)
    else server.once('listening', () => resolve((server.address() as AddressInfo).port))
  })

  beforeEach(async () => {
    initDirectLink(storage)
    await setDirectLinkSettings({ enabled: true })
    // The target's real server, and its direct listener in front of it.
    targetServer = serve({ fetch: (request) => onTarget.run(true, () => apps[target].fetch(request)), port: 0, hostname: '127.0.0.1' }) as http.Server
    const targetPort = await listening(targetServer)
    ingress = createDirectIngress({
      localPort: () => targetPort,
      localToken: () => undefined,
      delegationTunnelToken,
      selfNodeId: () => target,
      trustedPeer: (nodeId) => (isTrustedPeer(nodeId) ? { label: 'Origin' } : null),
      e2eeRequired: () => targetE2EE,
    })
    targetE2EE = true
    ingress.listen(0, '127.0.0.1')
    ingressBase = `http://127.0.0.1:${await listening(ingress)}`
    tailnet.set(address, ingressBase)
    // What the target said in its last sync.
    receivePeerSync(target, { peers: [], direct: address })
  })

  afterEach(async () => {
    releaseQuiet?.()
    releaseQuiet = undefined
    tailnet.clear()
    directLinkTestUtils.reset()
    for (const server of [ingress, targetServer]) {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  })

  const routeOf = async () => (await getDirectLinkStatus()).peers.find((peer) => peer.nodeId === target)

  it('reaches the other machine without Broker, end to end encrypted as before', async () => {
    const res = await relay('/echo/a?x=1&token=local-secret', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'hello' })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ method: 'PUT', path: '/api/echo/a', body: 'hello', type: 'text/plain' })
    expect(seen[0]).toMatchObject({ search: '?x=1', token: null })
    expect(forwarded).toHaveLength(0)
    expect(await routeOf()).toMatchObject({ address, mode: 'auto', route: 'direct' })
  })

  it('keeps a stream a stream', async () => {
    const res = await relay('/stream')
    expect(await res.text()).toBe('data: 1\n\ndata: 2\n\ndata: 3\n\n')
    expect(forwarded).toHaveLength(0)
  })

  it('keeps the receive switch and the denied routes', async () => {
    accepting[target] = false
    expect((await relay('/echo/a')).status).toBe(403)
    accepting[target] = true
    expect((await relay('/e2ee/devices')).status).toBe(403)
    expect(seen).toHaveLength(0)
    expect(forwarded).toHaveLength(0)
  })

  it('refuses a machine the target stopped trusting, before it reaches the server', async () => {
    revokePeer(origin)
    const res = await relay('/echo/a')
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'machine_not_paired' })
    expect(seen).toHaveLength(0)
  })

  it('goes through Broker when the direct route does not answer', async () => {
    tailnet.set(address, 'http://127.0.0.1:9')
    const res = await relay('/echo/a')
    expect(res.status).toBe(201)
    expect(forwarded.map((f) => f.to)).toEqual([target])
    expect(await routeOf()).toMatchObject({ route: 'broker', error: expect.any(String) })
  })

  it('set to direct only, fails rather than use Broker', async () => {
    setPeerMode(target, 'direct')
    tailnet.set(address, 'http://127.0.0.1:9')
    const res = await relay('/echo/a')
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'direct_unreachable' })
    expect(forwarded).toHaveLength(0)
  })

  it('goes through Broker when the direct listener turns the request away unread', async () => {
    targetE2EE = false
    const res = await relay('/echo/a')
    expect(res.status).toBe(201)
    expect(forwarded.map((f) => f.to)).toEqual([target])
    expect(await routeOf()).toMatchObject({ route: 'broker', error: expect.stringContaining('end-to-end encryption') })
  })

  it('set to direct only, reports the listener turning it away instead of using Broker', async () => {
    setPeerMode(target, 'direct')
    targetE2EE = false
    const res = await relay('/echo/a')
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'direct_unavailable' })
    expect(forwarded).toHaveLength(0)
  })

  it('takes the next request through Broker once a direct stream drops midway', async () => {
    const res = await relay('/quiet')
    const reader = res.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('first')
    expect(await routeOf()).toMatchObject({ route: 'direct' })
    ingress.closeAllConnections()
    await expect(reader.read()).rejects.toThrow()
    expect(await routeOf()).toMatchObject({ route: 'broker', error: 'The direct connection dropped' })
    expect((await relay('/echo/a')).status).toBe(201)
    expect(forwarded.map((f) => f.to)).toEqual([target])
  })

  it('set to Broker only, never tries the direct route', async () => {
    setPeerMode(target, 'broker')
    expect((await relay('/echo/a')).status).toBe(201)
    expect(forwarded.map((f) => f.to)).toEqual([target])
    expect(await routeOf()).toMatchObject({ mode: 'broker', route: 'broker' })
  })

  it('uses Broker for everyone once direct connections are turned off', async () => {
    await setDirectLinkSettings({ enabled: false })
    expect((await relay('/echo/a')).status).toBe(201)
    expect(forwarded.map((f) => f.to)).toEqual([target])
  })

  it('takes only a tailnet address from a sync, and forgets it when the machine stops listening', async () => {
    receivePeerSync(target, { peers: [], direct: 'http://192.168.1.20:47420' })
    expect((await routeOf())?.address).toBe(address)
    // A sync from a build without direct connections leaves it alone.
    receivePeerSync(target, { peers: [] })
    expect((await routeOf())?.address).toBe(address)
    receivePeerSync(target, { peers: [], direct: null })
    expect((await routeOf())?.address).toBeUndefined()
    expect((await relay('/echo/a')).status).toBe(201)
    expect(forwarded.map((f) => f.to)).toEqual([target])
  })
})

describe('without Broker', () => {
  const originAddress = 'http://100.100.0.1:47420'
  const targetAddress = 'http://100.100.0.2:47420'
  let servers: http.Server[]

  const listening = (server: http.Server) => new Promise<number>((resolve) => {
    if (server.listening) resolve((server.address() as AddressInfo).port)
    else server.once('listening', () => resolve((server.address() as AddressInfo).port))
  })

  /** A machine's real server and its direct listener, at its tailnet address. */
  async function onTailnet(nodeId: string, address: string) {
    const isTarget = nodeId === target
    const server = serve({ fetch: (request) => onTarget.run(isTarget, () => apps[nodeId].fetch(request)), port: 0, hostname: '127.0.0.1' }) as http.Server
    const port = await listening(server)
    const ingress = createDirectIngress({
      localPort: () => port,
      localToken: () => undefined,
      delegationTunnelToken,
      selfNodeId: () => nodeId,
      selfLabel: () => (isTarget ? 'Target' : 'Origin'),
      trustedPeer: (peer) => (onTarget.run(isTarget, () => isTrustedPeer(peer)) ? { label: null } : null),
      e2eeRequired: () => true,
    })
    ingress.listen(0, '127.0.0.1')
    tailnet.set(address, `http://127.0.0.1:${await listening(ingress)}`)
    servers.push(server, ingress)
  }

  beforeEach(async () => {
    servers = []
    initDirectLink(storage)
    await setDirectLinkSettings({ enabled: true })
    setBrokerEnabled(false)
    // The target also answers pairing claims, as every machine does.
    apps[target].route('/api/delegations', delegationRoutes(new DelegationHost(storage)))
    await onTailnet(origin, originAddress)
    await onTailnet(target, targetAddress)
    tailnetDevices.list = [{ ipv4: '100.100.0.1' }, { ipv4: '100.100.0.2' }]
  })

  afterEach(async () => {
    tailnetDevices.list = []
    tailnet.clear()
    directLinkTestUtils.reset()
    for (const server of servers) {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('finds the paired machine on the tailnet and reaches it there, never through Broker', async () => {
    const res = await apps[origin].request('/api/delegations/local/machines')
    const { machines } = await res.json() as { machines: Array<{ nodeId: string; online: boolean; paired?: boolean; current: boolean }> }
    expect(machines).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: target, online: true, paired: true, current: false }),
      expect.objectContaining({ nodeId: origin, current: true }),
    ]))
    expect((await relay('/echo/a', { method: 'POST', body: 'hi' })).status).toBe(201)
    expect(forwarded).toHaveLength(0)
  })

  it('says it cannot reach a machine that is not on the tailnet, rather than use Broker', async () => {
    tailnetDevices.list = []
    tailnet.delete(targetAddress)
    const res = await relay('/echo/a')
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'direct_unreachable' })
    expect(forwarded).toHaveLength(0)
  })

  it('pairs two machines with a code over Tailscale', async () => {
    revokePeer(target)
    revokePeer(origin)
    const { code } = startPairingCode()
    const peer = await onTarget.run(true, () => joinWithPairingCode(code))
    expect(peer).toMatchObject({ nodeId: origin, status: 'trusted', source: 'paired' })
    expect(forwarded).toHaveLength(0)
    // The origin learns where the target listens the next time it looks.
    await discoverMachines({ fresh: true })
    expect((await relay('/echo/a', { method: 'POST', body: 'hi' })).status).toBe(201)
    expect(forwarded).toHaveLength(0)
  })

  it('lets only the pairing claim through from a machine not paired yet', async () => {
    // The origin's record of the target.
    revokePeer(target)
    const listener = tailnet.get(originAddress)!
    // As the target, unpaired: anything but the claim is refused at the door.
    const res = await realFetch(`${listener}/api/echo/a`, { headers: { 'X-Operon-Device-Id': target } })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'machine_not_paired' })
  })
})
