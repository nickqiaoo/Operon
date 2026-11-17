import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk/unstable'
import { AcpConnection, type AcpSessionCallbacks } from './connection.js'

/**
 * Exercises {@link AcpConnection}'s routing against the real class.
 *
 * A small JSON-RPC agent forwards fixture requests into client notifications
 * and permission requests, exercising the SDK's real stdio parsing and routing.
 *
 * Behaviour under test is the sharing contract: updates reach only their own
 * session, permission requests are never answered by another conversation's
 * policy, and an update that arrives before its session registers is replayed
 * rather than dropped.
 */
const live: AcpConnection[] = []

const AGENT_SCRIPT = `
const rl = require('readline').createInterface({ input: process.stdin })
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
const pending = new Map()
let promptId
rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'fixture/update') {
    send({ method: 'session/update', params: message.params })
    send({ id: message.id, result: {} })
  } else if (message.method === 'fixture/permission') {
    const id = 'permission-' + message.id
    pending.set(id, message.id)
    send({ id, method: 'session/request_permission', params: message.params })
  } else if (pending.has(message.id)) {
    send({ id: pending.get(message.id), result: message.result })
    pending.delete(message.id)
  } else if (message.method === 'initialize') {
    send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: { loadSession: true } } })
  } else if (message.method === 'session/new') {
    send({ id: message.id, result: {
      sessionId: 's-a',
      models: { currentModelId: 'legacy-model', availableModels: [{ modelId: 'legacy-model', name: 'Legacy' }] },
      configOptions: [{ id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'high', name: 'High' }] }]
    } })
  } else if (message.method === 'session/prompt') {
    promptId = message.id
  } else if (message.method === 'session/cancel' && message.id === undefined) {
    send({ id: promptId, result: { stopReason: 'cancelled' } })
  }
})
`

afterEach(async () => {
  await Promise.all(live.splice(0).map((connection) => connection.dispose()))
})

function routingHarness() {
  const connection = new AcpConnection({
    providerId: 'test-agent',
    command: process.execPath,
    args: ['-e', AGENT_SCRIPT],
    cwd: process.cwd(),
    env: {},
    callbacks: {},
  })
  live.push(connection)
  return {
    agent: connection.agent,
    dispose: () => connection.dispose(),
    registerSession: (sessionId: string, callbacks: AcpSessionCallbacks) =>
      connection.registerSession(sessionId, callbacks),
    sessionUpdate: (params: acp.SessionNotification) => connection.agent.request('fixture/update', params),
    requestPermission: (params: acp.RequestPermissionRequest) =>
      connection.agent.request<acp.RequestPermissionResponse>('fixture/permission', params),
    exit: (error?: Error) =>
      (connection as unknown as { handleExit(error?: Error): void }).handleExit(error),
    sessionCount: () => connection.sessionCount,
  }
}

const update = (sessionId: string): acp.SessionNotification =>
  ({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } } })

const permission = (sessionId: string): acp.RequestPermissionRequest =>
  ({ sessionId, options: [], toolCall: { toolCallId: 'tool-1', title: 'Read file', status: 'pending' } })

const callbacks = (): AcpSessionCallbacks & {
  onSessionUpdate: ReturnType<typeof vi.fn>
  onRequestPermission: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
} => ({
  onSessionUpdate: vi.fn(),
  onRequestPermission: vi.fn(async () => ({ outcome: { outcome: 'cancelled' as const } })),
  onExit: vi.fn(),
})

describe('acp session routing', () => {
  it('keeps ACP v1 discovery fields and reasoning options through the new SDK', async () => {
    const conn = routingHarness()
    expect(await conn.agent.request('initialize', { protocolVersion: 1 })).toMatchObject({
      protocolVersion: 1, agentCapabilities: { loadSession: true },
    })
    expect(await conn.agent.request('session/new', { cwd: process.cwd(), mcpServers: [] })).toMatchObject({
      sessionId: 's-a', models: { currentModelId: 'legacy-model' },
      configOptions: [expect.objectContaining({ category: 'thought_level', currentValue: 'high' })],
    })
  })

  it('cancels an active prompt with a notification', async () => {
    const conn = routingHarness()
    const pending = conn.agent.request('session/prompt', {
      sessionId: 's-a', prompt: [{ type: 'text', text: 'Hello' }],
    })
    await conn.agent.notify('session/cancel', { sessionId: 's-a' })
    await expect(pending).resolves.toMatchObject({ stopReason: 'cancelled' })
  })

  it('rejects in-flight requests when the connection is disposed', async () => {
    const conn = routingHarness()
    const pending = conn.agent.request('fixture/pending', {})
    const rejected = expect(pending).rejects.toThrow('connection closed')
    await conn.dispose()
    await rejected
  })

  it('delivers an update only to the session it names', async () => {
    const conn = routingHarness()
    const a = callbacks()
    const b = callbacks()
    conn.registerSession('s-a', a)
    conn.registerSession('s-b', b)

    await conn.sessionUpdate(update('s-b'))

    expect(a.onSessionUpdate).not.toHaveBeenCalled()
    expect(b.onSessionUpdate).toHaveBeenCalledOnce()
  })

  it('replays updates that arrived before the session registered', async () => {
    const conn = routingHarness()
    // The agent can push about a session in the same tick it answers session/new.
    await conn.sessionUpdate(update('s-a'))
    await conn.sessionUpdate(update('s-a'))

    const a = callbacks()
    conn.registerSession('s-a', a)

    expect(a.onSessionUpdate).toHaveBeenCalledTimes(2)
  })

  it('does not replay one session’s buffered updates into another', async () => {
    const conn = routingHarness()
    await conn.sessionUpdate(update('s-a'))

    const b = callbacks()
    conn.registerSession('s-b', b)

    expect(b.onSessionUpdate).not.toHaveBeenCalled()
  })

  it('asks the owning session for a permission decision', async () => {
    const conn = routingHarness()
    const a = callbacks()
    const b = callbacks()
    a.onRequestPermission.mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'allow' } })
    conn.registerSession('s-a', a)
    conn.registerSession('s-b', b)

    const result = await conn.requestPermission(permission('s-a'))

    expect(b.onRequestPermission).not.toHaveBeenCalled()
    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
  })

  it('cancels rather than letting another conversation answer an orphan request', async () => {
    const conn = routingHarness()
    const b = callbacks()
    conn.registerSession('s-b', b)

    const result = await conn.requestPermission(permission('s-gone'))

    expect(b.onRequestPermission).not.toHaveBeenCalled()
    expect(result).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('stops delivering once a session detaches', async () => {
    const conn = routingHarness()
    const a = callbacks()
    const detach = conn.registerSession('s-a', a)
    detach()

    await conn.sessionUpdate(update('s-a'))

    expect(a.onSessionUpdate).not.toHaveBeenCalled()
  })

  it('tells every attached session when the process dies', () => {
    const conn = routingHarness()
    const a = callbacks()
    const b = callbacks()
    conn.registerSession('s-a', a)
    conn.registerSession('s-b', b)
    const boom = new Error('agent exited')

    conn.exit(boom)

    expect(a.onExit).toHaveBeenCalledWith(boom)
    expect(b.onExit).toHaveBeenCalledWith(boom)
    expect(conn.sessionCount()).toBe(0)
  })
})
