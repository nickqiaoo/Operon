import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as acp from '@zed-industries/agent-client-protocol'
import type { RuntimeSessionParams } from '../../types.js'
import type { AcpProviderConfig } from './types.js'

/**
 * Covers resuming an ACP conversation across an app restart.
 *
 * The host stores the agent's own session id and hands it back on the next run;
 * these assert the session actually spends it on `session/load` when the agent
 * can, and degrades to a fresh session — rather than a dead chat — when it
 * cannot. The connection registry is mocked because the behaviour under test is
 * the choice between load and new, not the stdio transport.
 */
const acquireAcpConnection = vi.hoisted(() => vi.fn())
vi.mock('./connection-registry.js', () => ({ acquireAcpConnection }))

const { AcpRuntimeSession } = await import('./session.js')

const CONFIG: AcpProviderConfig = {
  providerId: 'test-acp',
  cliId: 'test-acp',
  label: 'Test ACP',
  logo: '',
  agentArgs: ['acp'],
  fallbackCommand: 'test-acp-cli',
  modes: [{ id: 'default', name: 'Default' }],
  defaultModeId: 'default',
  defaultModelId: 'test-model',
  features: {},
  modelProbe: 'none',
  extractModels: () => ({ models: [], currentModelId: 'test-model' }),
} as unknown as AcpProviderConfig

interface Harness {
  newSession: ReturnType<typeof vi.fn>
  loadSession: ReturnType<typeof vi.fn>
  registerSession: ReturnType<typeof vi.fn>
  unregister: ReturnType<typeof vi.fn>
  /** Call order across register/load/new, for asserting the replay window. */
  calls: string[]
}

function mockConnection(options: { canLoad: boolean; loadFails?: boolean }): Harness {
  const calls: string[] = []
  const unregister = vi.fn(() => void calls.push('unregister'))
  const harness: Harness = {
    newSession: vi.fn(async () => {
      calls.push('newSession')
      return { sessionId: 'fresh-session' }
    }),
    loadSession: vi.fn(async () => {
      calls.push('loadSession')
      if (options.loadFails) throw new Error('session not found')
      return {}
    }),
    registerSession: vi.fn(() => {
      calls.push('registerSession')
      return unregister
    }),
    unregister,
    calls,
  }

  const connection = {
    agent: {
      newSession: harness.newSession,
      ...(options.canLoad ? { loadSession: harness.loadSession } : {}),
    },
    registerSession: harness.registerSession,
  }

  acquireAcpConnection.mockResolvedValue({
    connection,
    initialize: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: options.canLoad },
    } as acp.InitializeResponse,
    release: vi.fn(),
  })

  return harness
}

async function connect(params: Partial<RuntimeSessionParams>): Promise<InstanceType<typeof AcpRuntimeSession>> {
  const session = new AcpRuntimeSession({ cwd: '/tmp/workspace', ...params } as RuntimeSessionParams, CONFIG)
  await (session as unknown as { ensureConnected(): Promise<void> }).ensureConnected()
  return session
}

beforeEach(() => {
  acquireAcpConnection.mockReset()
})

describe('AcpRuntimeSession session/load', () => {
  it('resumes the stored session instead of opening a new one', async () => {
    const harness = mockConnection({ canLoad: true })

    const session = await connect({ sessionId: 'stored-session' })

    expect(harness.loadSession).toHaveBeenCalledWith({
      sessionId: 'stored-session',
      cwd: '/tmp/workspace',
      mcpServers: [],
    })
    expect(harness.newSession).not.toHaveBeenCalled()
    expect(session.getSessionId()).toBe('stored-session')
  })

  it('registers callbacks before loading, so the replayed history is routed', async () => {
    // The agent streams the whole conversation back while it restores. Those
    // notifications are dropped downstream (no active mapper during connect),
    // but `available_commands_update` is not — it has to reach the session.
    const harness = mockConnection({ canLoad: true })

    await connect({ sessionId: 'stored-session' })

    expect(harness.calls).toEqual(['registerSession', 'loadSession'])
  })

  it('opens a new session when the agent does not advertise loadSession', async () => {
    const harness = mockConnection({ canLoad: false })

    const session = await connect({ sessionId: 'stored-session' })

    expect(harness.loadSession).not.toHaveBeenCalled()
    expect(harness.newSession).toHaveBeenCalledOnce()
    expect(session.getSessionId()).toBe('fresh-session')
  })

  it('opens a new session when there is nothing to resume', async () => {
    const harness = mockConnection({ canLoad: true })

    const session = await connect({})

    expect(harness.loadSession).not.toHaveBeenCalled()
    expect(session.getSessionId()).toBe('fresh-session')
  })

  it('falls back to a new session when the stored id is no longer loadable', async () => {
    // A pruned or expired session must not brick the chat: the new id replaces
    // the stale one in the host's record once the turn ends.
    const harness = mockConnection({ canLoad: true, loadFails: true })

    const session = await connect({ sessionId: 'stale-session' })

    expect(harness.loadSession).toHaveBeenCalledOnce()
    expect(harness.newSession).toHaveBeenCalledOnce()
    expect(session.getSessionId()).toBe('fresh-session')
  })

  it('detaches the failed load’s callbacks before registering the new session', async () => {
    // Leaving them attached would leave a dead session id routing into a live
    // conversation on the shared connection.
    const harness = mockConnection({ canLoad: true, loadFails: true })

    await connect({ sessionId: 'stale-session' })

    expect(harness.unregister).toHaveBeenCalledOnce()
    expect(harness.calls).toEqual(['registerSession', 'loadSession', 'unregister', 'newSession', 'registerSession'])
  })
})
