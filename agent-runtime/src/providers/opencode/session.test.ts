import { describe, expect, it, vi } from 'vitest'
import type { McpStatus } from '@opencode-ai/sdk/v2'
import { OpencodeRuntimeSession } from './session.js'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('OpenCode MCP session control', () => {
  it('maps SDK status into the shared Session panel shape', async () => {
    const session = new OpencodeRuntimeSession({
      cwd: '/workspace',
      mcpServers: {
        local: { command: 'local-mcp' },
        remote: { type: 'http', url: 'https://example.com/mcp' },
        events: { type: 'sse', url: 'https://example.com/events' },
      },
    })
    const status = vi.fn(async () => ({
      data: {
        local: { status: 'connected' },
        remote: { status: 'disabled' },
        events: { status: 'failed', error: 'Connection refused' },
        oauth: { status: 'needs_auth' },
        registration: {
          status: 'needs_client_registration',
          error: 'Dynamic registration is unavailable',
        },
      } satisfies Record<string, McpStatus>,
    }))
    Object.assign(session, {
      clientManager: {
        getClient: vi.fn(async () => ({ mcp: { status } })),
      },
    })

    await expect(session.agentControl('mcp.list', undefined)).resolves.toEqual({
      servers: [
        { name: 'local', status: 'connected', transport: 'stdio' },
        { name: 'remote', status: 'disabled', transport: 'http' },
        {
          name: 'events',
          status: 'failed',
          transport: 'sse',
          error: 'Connection refused',
        },
        { name: 'oauth', status: 'needs-auth' },
        {
          name: 'registration',
          status: 'needs-client-registration',
          error: 'Dynamic registration is unavailable',
        },
      ],
    })
    expect(status).toHaveBeenCalledWith(
      { directory: '/workspace' },
      { throwOnError: true },
    )
  })

  it('maps toggle and reconnect to disconnect and connect', async () => {
    const session = new OpencodeRuntimeSession({ cwd: '/workspace' })
    let currentStatus: McpStatus = { status: 'connected' }
    const status = vi.fn(async () => ({
      data: { browser: currentStatus },
    }))
    const connect = vi.fn(async () => {
      currentStatus = { status: 'connected' }
      return { data: true }
    })
    const disconnect = vi.fn(async () => {
      currentStatus = { status: 'disabled' }
      return { data: true }
    })
    Object.assign(session, {
      clientManager: {
        getClient: vi.fn(async () => ({
          mcp: { status, connect, disconnect },
        })),
      },
    })

    await expect(
      session.agentControl('mcp.toggle', { name: 'browser', enabled: false }),
    ).resolves.toEqual({ ok: true })
    expect(disconnect).toHaveBeenCalledWith(
      { name: 'browser', directory: '/workspace' },
      { throwOnError: true },
    )

    await expect(
      session.agentControl('mcp.toggle', { name: 'browser', enabled: true }),
    ).resolves.toEqual({ ok: true })
    await expect(
      session.agentControl('mcp.reconnect', { name: 'browser' }),
    ).resolves.toEqual({ ok: true })
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('holds the next injected message until MCP connection is ready', async () => {
    const session = new OpencodeRuntimeSession({
      cwd: '/workspace',
      sessionId: 'session-1',
    })
    const connection = deferred<void>()
    let currentStatus: McpStatus = { status: 'disabled' }
    const status = vi.fn(async () => ({
      data: { browser: currentStatus },
    }))
    const connect = vi.fn(async () => {
      await connection.promise
      currentStatus = { status: 'connected' }
      return { data: true }
    })
    const promptAsync = vi.fn(async () => ({ data: true }))
    Object.assign(session, {
      clientManager: {
        getClient: vi.fn(async () => ({
          mcp: { status, connect },
          session: { promptAsync },
        })),
      },
    })

    const reconnecting = session.agentControl('mcp.reconnect', { name: 'browser' })
    const injecting = session.injectMessage('continue')
    await Promise.resolve()
    await Promise.resolve()
    expect(promptAsync).not.toHaveBeenCalled()

    connection.resolve()
    await reconnecting
    await injecting
    expect(promptAsync).toHaveBeenCalledWith({
      sessionID: 'session-1',
      directory: '/workspace',
      parts: [{ type: 'text', text: 'continue' }],
    })
  })
})
