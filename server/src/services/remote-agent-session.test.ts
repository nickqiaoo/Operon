import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import type { AgentInput, AgentSession, PermissionDecision, RuntimeStreamPart, SendOptions, SessionPatch } from '@operon/agent-runtime'
import {
  DELEGATION_PUBLIC_KEY_HEADER, DELEGATION_SOURCE_HEADER, DELEGATION_SOURCE_LABEL_HEADER, DELEGATION_TUNNEL_HEADER,
  REMOTE_TUNNEL_HEADER, bytesToBase64,
} from '@shared/e2ee/protocol'
import { createDeviceKeypair, fingerprintPublicKey } from '@shared/e2ee/crypto'
import { decodeWire, encodeWire, nodeDelegationRoute, type RemoteExecutionRef } from '@shared/delegations'
import { SqliteStorage } from '../storage/sqlite.js'
import { delegationRoutes } from '../routes/delegations.js'
import { createRemoteE2EEMiddleware, initRemoteE2EE } from './remote-e2ee.js'
import { delegationTunnelToken } from './delegation-tunnel.js'
import { DelegationHost } from './delegation-host.js'
import { RemoteAgentSession, createRemoteAgentSession } from './remote-agent-session.js'

const source = 'a'.repeat(32)
const target = 'b'.repeat(32)
const account = 'd'.repeat(32)
const onTarget = new AsyncLocalStorage<boolean>()
const keys = { origin: createDeviceKeypair(), target: createDeviceKeypair() }
const local = () => onTarget.getStore() ? keys.target : keys.origin
const settings = (nodeId: string) => ({ nodeId, nodeToken: `token-${nodeId}`, userId: account, label: nodeId === source ? 'Source' : 'Target' })

const fake = vi.hoisted(() => ({ sessions: [] as unknown[], created: [] as Array<Record<string, unknown>> }))

vi.mock('../gateway/saas/config.js', () => ({ getSaasConfig: () => settings(onTarget.getStore() ? target : source) }))
vi.mock('./mobile/identity.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./mobile/identity.js')>(),
  getDelegationKeypair: () => ({ ...local(), fingerprint: fingerprintPublicKey(local().publicKey) }),
}))
vi.mock('./ai/providers.js', () => ({
  getProviders: () => [{ id: 'codex', available: true }],
  getProviderModels: async () => ({
    currentModelId: 'gpt-remote', models: [{ modelId: 'gpt-remote', name: 'Remote model' }], configOptions: [],
    features: { dynamicSwitch: true, steer: true, followup: false, goal: true, sideChat: true },
  }),
}))
vi.mock('./ai/state.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./ai/state.js')>(),
  getSessionManager: () => ({
    createStandaloneSession: async (_provider: string, options: Record<string, unknown>) => {
      fake.created.push(options)
      const session = new FakeSession()
      fake.sessions.push(session)
      return session
    },
  }),
}))

/** Answers each turn with text, asks once for approval, and reports a native session id. */
class FakeSession implements AgentSession {
  id: string | undefined = undefined
  aborted = false
  inputs: AgentInput[] = []
  patches: SessionPatch[] = []
  decisions: Array<[string, PermissionDecision]> = []
  private approve?: () => void

  async *send(input: AgentInput, options?: SendOptions): AsyncIterable<RuntimeStreamPart> {
    this.inputs.push(input)
    yield { type: 'start' } as RuntimeStreamPart
    yield { type: 'text-delta', id: 't', text: 'working', providerMetadata: { codex: { sessionId: 'thread-1' } } } as unknown as RuntimeStreamPart
    if (input === 'ask') {
      yield { type: 'tool-approval-request', approvalId: 'ap-1', toolCall: { toolCallId: 'c1', toolName: 'Bash', input: { command: 'ls' } } } as unknown as RuntimeStreamPart
      await new Promise<void>((resolve) => { this.approve = resolve })
    }
    if (input === 'hang') {
      await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }))
      return
    }
    yield { type: 'finish' } as RuntimeStreamPart
  }
  abort() { this.aborted = true }
  async close() {}
  respond(approvalId: string, decision: PermissionDecision) {
    this.decisions.push([approvalId, decision])
    this.approve?.()
    return true
  }
  async set(patch: SessionPatch) { this.patches.push(patch); return Object.keys(patch) as Array<keyof SessionPatch> }
  state() { return { currentModelId: 'gpt-remote' } }
}

let root: string
let storage: SqliteStorage
let host: DelegationHost
let stopHost: (() => void) | undefined
let workspaceId: number
let ref: RemoteExecutionRef

beforeEach(() => {
  fake.sessions.length = 0
  fake.created.length = 0
  root = mkdtempSync(path.join(tmpdir(), 'operon-remote-agent-'))
  const repo = path.join(root, 'repo')
  mkdirSync(repo)
  storage = new SqliteStorage(path.join(root, 'target.sqlite'))
  const project = storage.createProject({ name: 'Target project', rootPath: repo })
  workspaceId = storage.createWorkspace(project.id, { name: 'main', worktreePath: repo, branchName: 'main' }).id
  ref = { nodeId: target, machine: 'Target', workspaceId, workspace: 'Target project / main', sessionId: crypto.randomUUID() }
  host = new DelegationHost(storage)
  stopHost = host.init()
  host.setAccepting(true)
  initRemoteE2EE({ storage, mode: 'required' })
  const app = new Hono()
  app.use('/api/*', createRemoteE2EEMiddleware({ acceptsMachines: () => host.accepting() }))
  app.route('/api/delegations', delegationRoutes(host))
  // Broker: authenticates the caller by node token, hands out registered keys, and
  // stamps the verified source onto the request it tunnels to the target.
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === '/agent/delegation-nodes') {
      if (!url.searchParams.get('nodeId')) return Response.json([{ nodeId: source, label: 'Source', online: true }, { nodeId: target, label: 'Target', online: true }])
      return Response.json({ publicKey: bytesToBase64(keys.target.publicKey) })
    }
    const headers = new Headers(init?.headers)
    headers.delete('authorization')
    headers.set(REMOTE_TUNNEL_HEADER, '1')
    headers.set(DELEGATION_TUNNEL_HEADER, delegationTunnelToken)
    headers.set(DELEGATION_SOURCE_HEADER, source)
    headers.set(DELEGATION_SOURCE_LABEL_HEADER, bytesToBase64(new TextEncoder().encode('Dev box')))
    headers.set(DELEGATION_PUBLIC_KEY_HEADER, bytesToBase64(keys.origin.publicKey))
    const apiPath = url.pathname.slice(url.pathname.indexOf('/api/'))
    return onTarget.run(true, () => app.request(`${apiPath}${url.search}`, { ...init, headers }))
  }))
})

afterEach(() => {
  stopHost?.()
  vi.unstubAllGlobals()
  storage.close()
  rmSync(root, { recursive: true, force: true })
})

async function collect(parts: AsyncIterable<RuntimeStreamPart>): Promise<RuntimeStreamPart[]> {
  const out: RuntimeStreamPart[] = []
  for await (const part of parts) out.push(part)
  return out
}

describe('remote agent session', () => {
  it('streams the remote turn and resumes the native thread by id', async () => {
    const session = await createRemoteAgentSession('codex', ref, { model: 'gpt-remote' })
    const parts = await collect(session.send('hello'))
    expect(parts.map((part) => part.type)).toEqual(['start', 'text-delta', 'finish'])
    expect(session.id).toBe('thread-1')
    expect(session.state()).toEqual({ currentModelId: 'gpt-remote' })
    expect(fake.created[0]).toMatchObject({ cwd: path.join(root, 'repo'), model: 'gpt-remote' })

    // The target forgets the session (restart, idle); the next one picks the thread back up.
    await session.close()
    await collect(session.send('again'))
    expect(fake.created).toHaveLength(2)
    expect(fake.created[1]).toMatchObject({ resume: 'thread-1' })
    expect(host.recent()[0]).toMatchObject({ sourceNodeId: source, sourceLabel: 'Dev box', providerId: 'codex', status: 'idle' })
  })

  it('relays an approval to the agent waiting on the other machine', async () => {
    const session = await createRemoteAgentSession('codex', ref, {})
    const parts: RuntimeStreamPart[] = []
    for await (const part of session.send('ask')) {
      parts.push(part)
      if (part.type === 'tool-approval-request') expect(session.respond(part.approvalId, { type: 'allow' })).toBe(true)
    }
    expect(parts.at(-1)?.type).toBe('finish')
    expect((fake.sessions[0] as FakeSession).decisions).toEqual([['ap-1', { type: 'allow' }]])
    expect(session.respond('ap-1', { type: 'deny' })).toBe(false)
  })

  it('exposes what the target provider supports and applies live settings there', async () => {
    const session = await createRemoteAgentSession('codex', ref, {})
    expect(typeof session.set).toBe('function')
    expect(typeof session.steer).toBe('function')
    expect(session.followup).toBeUndefined()
    // No live session on the target yet: the change rides the next turn.
    expect(await session.set!({ model: 'gpt-next' })).toEqual(['model'])
    await collect(session.send('hello'))
    expect(fake.created[0]).toMatchObject({ model: 'gpt-next' })
    expect(await session.set!({ mode: 'plan', serviceTier: undefined })).toEqual(['mode', 'serviceTier'])
    expect((fake.sessions[0] as FakeSession).patches).toEqual([{ mode: 'plan', serviceTier: undefined }])
  })

  it('stops the remote turn when the origin aborts', async () => {
    const session = await createRemoteAgentSession('codex', ref, {})
    const turn = collect(session.send('hang'))
    await vi.waitFor(() => expect(fake.sessions).toHaveLength(1))
    session.abort()
    await turn
    await vi.waitFor(() => expect((fake.sessions[0] as FakeSession).aborted).toBe(true))
  })

  it('refuses work when the target stopped accepting it', async () => {
    host.setAccepting(false)
    const session = new RemoteAgentSession('codex', ref, {})
    await expect(collect(session.send('hello'))).rejects.toThrow(/not accepting/)
  })

  it('lets another machine use the whole API except who-may-reach-this-machine settings', () => {
    const id = crypto.randomUUID()
    for (const path of [`/api/delegations/sessions/${id}/turn`, '/api/chat-history', '/api/fs/read?path=x', '/api/terminal/ws', '/api/git/status']) {
      expect(nodeDelegationRoute('GET', path)).toBe(true)
      expect(nodeDelegationRoute('DELETE', path)).toBe(true)
    }
    expect(nodeDelegationRoute('OPTIONS', '/api/chat-history')).toBe(false)
    for (const path of ['/api/delegations/local/settings', '/api/e2ee/devices', '/api/E2EE/devices', '/api/saas/config',
      '/api/remote/abc/fs/read', '/api/integrations/events/linear', '/api/fs/../e2ee/devices', '/api//e2ee', '/health']) {
      expect(nodeDelegationRoute('POST', path)).toBe(false)
    }
  })

  it('keeps binary input and errors across the wire', () => {
    const decoded = decodeWire<{ data: Uint8Array; error: Error }>(encodeWire({ data: new Uint8Array([1, 2, 3]), error: new Error('boom') }))
    expect([...decoded.data]).toEqual([1, 2, 3])
    expect(decoded.error.message).toBe('boom')
  })
})
