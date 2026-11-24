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
import { DELEGATED_AGENT_EVENTS_PATH, type DelegatedAgentStarted } from '@shared/delegations'
import { SqliteStorage } from '../storage/sqlite.js'
import { delegationRoutes } from '../routes/delegations.js'
import { remoteMachineRoutes } from '../routes/remote-machines.js'
import { createRemoteE2EEMiddleware, initRemoteE2EE } from './remote-e2ee.js'
import { delegationTunnelToken } from './delegation-tunnel.js'
import { DelegationHost } from './delegation-host.js'
import { initRemoteAgents, listRemoteAgents, reportToParentMachine, startRemoteAgent } from './remote-agents.js'
import { delegationRequest } from './delegation-transport.js'

/**
 * Two machines of one account in one process: the origin (whose UI and
 * conversations start things) and the target, joined by a stand-in for Broker
 * that authenticates by node, hands out registered keys and stamps the source
 * machine — with the real end-to-end encryption in between.
 */

const origin = 'a'.repeat(32)
const target = 'b'.repeat(32)
const account = 'd'.repeat(32)
const onTarget = new AsyncLocalStorage<boolean>()
const keys = { [origin]: createDeviceKeypair(), [target]: createDeviceKeypair() }
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
    alwaysFromMachines: (p) => p === DELEGATED_AGENT_EVENTS_PATH,
  }))
  routes(app)
  return app
}

let apps: Record<string, Hono>

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'operon-remote-machines-'))
  storage = new SqliteStorage(path.join(root, 'test.sqlite'))
  initRemoteE2EE({ storage, mode: 'required' })
  stopRemoteAgents = initRemoteAgents(storage)
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
      const asked = url.searchParams.get('nodeId')
      if (!asked) return Response.json([{ nodeId: origin, label: 'Origin', online: true }, { nodeId: target, label: 'Target', online: true }])
      return Response.json({ publicKey: bytesToBase64(keys[asked].publicKey) })
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
    headers.set(DELEGATION_PUBLIC_KEY_HEADER, bytesToBase64(keys[from].publicKey))
    const apiPath = url.pathname.slice(url.pathname.indexOf('/api/'))
    return onTarget.run(to === target, () => apps[to].request(`${apiPath}${url.search}`, { ...init, headers }))
  }))
})

afterEach(() => {
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
