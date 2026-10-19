import { describe, expect, it, vi } from 'vitest'
import type { McpStatus } from '@opencode-ai/sdk/v2'
import { OpencodeRuntimeSession } from './session.js'
import { createRuntimeContext } from '../../context.js'
import type { RuntimeStreamPart } from '../../types.js'
import type { Message, OpencodeEvent } from './event-stream.js'

const ctx = createRuntimeContext()

describe('OpenCode compaction message routing', () => {
  const message = (id: string, extra: Partial<Message> = {}): OpencodeEvent => ({
    type: 'message.updated',
    properties: { info: { id, sessionID: 'session-1', role: 'assistant', ...extra } },
  })
  const part = (messageID: string, type: string, extra: Record<string, unknown> = {}): OpencodeEvent => ({
    type: 'message.part.updated',
    properties: { part: { id: `${messageID}-${type}`, messageID, sessionID: 'session-1', type, ...extra } },
  })

  async function stream(events: OpencodeEvent[]): Promise<RuntimeStreamPart[]> {
    const session = new OpencodeRuntimeSession({ cwd: '/workspace', resume: 'session-1' }, ctx)
    Object.assign(session, {
      mcpRegistered: true,
      clientManager: {
        getClient: async () => ({
          event: { subscribe: async () => ({ stream: (async function* () { yield* events })() }) },
          session: { prompt: async () => ({}) },
        }),
      },
    })
    const parts: RuntimeStreamPart[] = []
    for await (const entry of session.send('hello')) parts.push(entry)
    return parts
  }

  it('keeps the reply and its usage while hiding an automatic checkpoint', async () => {
    const tokens = { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }
    const parts = await stream([
      message('answer', { finish: 'stop', tokens }),
      part('answer', 'text', { text: 'Hello!' }),
      part('answer', 'step-finish', { reason: 'stop', cost: 0, tokens }),
      message('checkpoint', { summary: true, agent: 'compaction', finish: 'length', tokens: { input: 900 } }),
      part('checkpoint', 'step-start'),
      part('checkpoint', 'reasoning', { text: 'Summarizing the greeting' }),
      part('checkpoint', 'text', { text: '## Objective\n- No task yet' }),
      { type: 'session.compacted', properties: { sessionID: 'session-1' } },
      { type: 'session.idle', properties: { sessionID: 'session-1' } },
    ])
    expect(parts.filter((entry) => entry.type === 'text-delta')).toEqual([
      { type: 'text-delta', id: 'answer-text', text: 'Hello!' },
    ])
    expect(parts.some((entry) => entry.type.startsWith('reasoning-'))).toBe(false)
    expect(parts.filter((entry) => entry.type === 'start-step')).toHaveLength(1)
    expect(parts).toContainEqual(expect.objectContaining({
      type: 'finish', finishReason: 'stop', totalUsage: expect.objectContaining({ inputTokens: 100 }),
    }))
    expect(parts).toContainEqual(expect.objectContaining({
      type: 'message-metadata', metadata: expect.objectContaining({ compacted: { compacted: true } }),
    }))
  })

  it('still surfaces checkpoint failures without showing its content', async () => {
    const parts = await stream([
      message('checkpoint', { summary: true, error: { name: 'ContextOverflowError', data: { message: 'Context too large' } } }),
      part('checkpoint', 'text', { text: 'Internal checkpoint' }),
      { type: 'session.idle', properties: { sessionID: 'session-1' } },
    ])
    expect(parts).toContainEqual({ type: 'error', error: new Error('Context too large') })
    expect(parts).toContainEqual(expect.objectContaining({ type: 'finish', finishReason: 'error' }))
    expect(parts.some((entry) => entry.type === 'text-delta')).toBe(false)
  })
})

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
    }, ctx)
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

    await expect(session.native.mcp.list()).resolves.toEqual([
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
      ])
    expect(status).toHaveBeenCalledWith(
      { directory: '/workspace' },
      { throwOnError: true },
    )
  })

  it('maps toggle and reconnect to disconnect and connect', async () => {
    const session = new OpencodeRuntimeSession({ cwd: '/workspace' }, ctx)
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
      session.native.mcp.toggle('browser', false),
    ).resolves.toBeUndefined()
    expect(disconnect).toHaveBeenCalledWith(
      { name: 'browser', directory: '/workspace' },
      { throwOnError: true },
    )

    await expect(
      session.native.mcp.toggle('browser', true),
    ).resolves.toBeUndefined()
    await expect(
      session.native.mcp.reconnect('browser'),
    ).resolves.toBeUndefined()
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('holds the next injected message until MCP connection is ready', async () => {
    const session = new OpencodeRuntimeSession({
      cwd: '/workspace',
      resume: 'session-1',
    }, ctx)
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

    const reconnecting = session.native.mcp.reconnect('browser')
    const injecting = session.inject('continue')
    await Promise.resolve()
    await Promise.resolve()
    expect(promptAsync).not.toHaveBeenCalled()

    connection.resolve()
    await reconnecting
    await injecting
    expect(promptAsync).toHaveBeenCalledWith({
      sessionID: 'session-1',
      directory: '/workspace',
      messageID: expect.stringMatching(/^msg_/),
      parts: [{ type: 'text', text: 'continue' }],
    })
  })
})

describe('OpenCode side chat', () => {
  function mockForkableClient() {
    const fork = vi.fn(async () => ({ data: { id: 'fork-1' } }))
    const promptAsync = vi.fn(async () => ({ data: {} }))
    const remove = vi.fn(async () => ({ data: true }))
    const create = vi.fn(async () => ({ data: { id: 'fresh-1' } }))
    const client = { session: { fork, promptAsync, delete: remove, create } }
    return {
      fork,
      promptAsync,
      remove,
      create,
      clientManager: { getClient: vi.fn(async () => client) },
    }
  }

  it('branches off the parent once and reuses the branch after that', async () => {
    const session = new OpencodeRuntimeSession({
      cwd: '/workspace',
      fork: { from: 'parent-1', ephemeral: true },
    }, ctx)
    const mocks = mockForkableClient()
    Object.assign(session, { clientManager: mocks.clientManager })

    await session.inject('hello')
    expect(mocks.fork).toHaveBeenCalledWith({
      sessionID: 'parent-1',
      directory: '/workspace',
    })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(session.id).toBe('fork-1')

    await session.inject('again')
    expect(mocks.fork).toHaveBeenCalledTimes(1)
  })

  it('deletes the branch it forked when discarded, but keeps it across a rebuild', async () => {
    const session = new OpencodeRuntimeSession({
      cwd: '/workspace',
      fork: { from: 'parent-1', ephemeral: true },
    }, ctx)
    const mocks = mockForkableClient()
    Object.assign(session, { clientManager: mocks.clientManager })

    await session.inject('hello')

    await session.close('rebuild')
    expect(mocks.remove).not.toHaveBeenCalled()
    // The rebuilt session resumes the branch by id, so it must still be known.
    expect(session.id).toBe('fork-1')

    await session.close('discard')
    expect(mocks.remove).toHaveBeenCalledWith({
      sessionID: 'fork-1',
      directory: '/workspace',
    })
  })

  it('creates an ordinary session and never deletes it', async () => {
    const session = new OpencodeRuntimeSession({ cwd: '/workspace' }, ctx)
    const mocks = mockForkableClient()
    Object.assign(session, { clientManager: mocks.clientManager })

    await session.inject('hello')
    expect(mocks.create).toHaveBeenCalled()
    expect(mocks.fork).not.toHaveBeenCalled()

    await session.close()
    expect(mocks.remove).not.toHaveBeenCalled()
  })
})
