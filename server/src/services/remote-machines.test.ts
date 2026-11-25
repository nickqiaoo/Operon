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
import { joinWithPairingCode, machinePairingTestUtils, startPairingCode } from './machine-pairing.js'

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
