import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as acp from '@zed-industries/agent-client-protocol'
import { AcpConnection, type AcpSessionCallbacks } from './connection.js'

/**
 * Exercises {@link AcpConnection}'s routing against the real class.
 *
 * The constructor spawns, so these back it with an inert process that just holds
 * its stdio open — enough for the connection to build its streams, and nothing
 * ever comes back over them. The two client callbacks the agent would drive
 * (`session/update`, `session/request_permission`) are reached through
 * `createClient()`, which is what the SDK itself calls.
 *
 * Behaviour under test is the sharing contract: updates reach only their own
 * session, permission requests are never answered by another conversation's
 * policy, and an update that arrives before its session registers is replayed
 * rather than dropped.
 */
const live: AcpConnection[] = []

afterEach(async () => {
  await Promise.all(live.splice(0).map((connection) => connection.dispose()))
})

function routingHarness() {
  const connection = new AcpConnection({
    providerId: 'test-agent',
    // Inert stand-in for the agent CLI: holds stdio open, says nothing.
    command: process.execPath,
    args: ['-e', 'process.stdin.resume()'],
    cwd: process.cwd(),
    env: {},
    callbacks: {},
  })
  live.push(connection)
  const client = (connection as unknown as { createClient(): acp.Client }).createClient()

  return {
    registerSession: (sessionId: string, callbacks: AcpSessionCallbacks) =>
      connection.registerSession(sessionId, callbacks),
    sessionUpdate: (params: acp.SessionNotification) => client.sessionUpdate(params),
    requestPermission: (params: acp.RequestPermissionRequest) => client.requestPermission(params),
    exit: (error?: Error) =>
      (connection as unknown as { handleExit(error?: Error): void }).handleExit(error),
    sessionCount: () => connection.sessionCount,
  }
}

const update = (sessionId: string): acp.SessionNotification =>
  ({ sessionId, update: { sessionUpdate: 'agent_message_chunk' } }) as unknown as acp.SessionNotification

const permission = (sessionId: string): acp.RequestPermissionRequest =>
  ({ sessionId, options: [], toolCall: {} }) as unknown as acp.RequestPermissionRequest

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
