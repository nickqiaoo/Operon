import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppServerClient, REQUEST_NOT_HANDLED } from './app-server-client.js'
import { acquireAppServerClient, disposeAllAppServerClients } from './client-registry.js'
import type { CodexAppServerSettings } from './types/index.js'
import { listModels, listSkills } from './discovery.js'
import { getCodexAccountUsage } from '../usage-probe.js'
import { createRuntimeContext } from '../../../context.js'

afterEach(() => {
  disposeAllAppServerClients()
  vi.restoreAllMocks()
})

const settings = (over: Partial<CodexAppServerSettings> = {}): CodexAppServerSettings => ({
  codexPath: '/usr/local/bin/codex',
  logger: false,
  ...over,
})

/**
 * Drives the client's server-request dispatch without a real app-server: feeds a
 * JSON-RPC request in through the private message handler and captures what
 * would have gone back over stdin.
 */
function harness() {
  const client = new AppServerClient(settings())
  const internals = client as unknown as {
    handleMessage: (msg: unknown) => void
    sendResponse: (id: string | number, result?: unknown, error?: unknown) => void
  }
  const responses: Array<{ result?: unknown; error?: unknown }> = []
  internals.sendResponse = (_id, result, error) => {
    responses.push({ result, error })
  }
  const send = async (method: string, params: unknown) => {
    internals.handleMessage({ id: 1, method, params })
    // Dispatch awaits each handler, so let the microtask queue drain.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { client, responses, send }
}

describe('server request dispatch', () => {
  it('passes a request on when the handler declines it', async () => {
    const { client, responses, send } = harness()
    const foreign = vi.fn(() => REQUEST_NOT_HANDLED)
    const mine = vi.fn(() => ({ decision: 'approve' }))
    client.onRequest('item/commandExecution/requestApproval', foreign)
    client.onRequest('item/commandExecution/requestApproval', mine)

    await send('item/commandExecution/requestApproval', { threadId: 'b' })

    expect(foreign).toHaveBeenCalledOnce()
    expect(mine).toHaveBeenCalledOnce()
    expect(responses).toEqual([{ result: { decision: 'approve' }, error: undefined }])
  })

  it('stops at the first handler that claims the request', async () => {
    const { client, responses, send } = harness()
    const first = vi.fn(() => ({ decision: 'approve' }))
    const second = vi.fn(() => ({ decision: 'decline' }))
    client.onRequest('m', first)
    client.onRequest('m', second)

    await send('m', {})

    expect(second).not.toHaveBeenCalled()
    expect(responses[0].result).toEqual({ decision: 'approve' })
  })

  it('runs fallbacks only after every ordinary handler declines', async () => {
    const { client, responses, send } = harness()
    const fallback = vi.fn(() => ({ action: 'accept' }))
    const owner = vi.fn(() => REQUEST_NOT_HANDLED)
    client.onRequest('m', fallback, { fallback: true })
    client.onRequest('m', owner)

    await send('m', {})

    expect(owner).toHaveBeenCalledOnce()
    expect(responses[0].result).toEqual({ action: 'accept' })
  })

  it('errors rather than guessing when nobody claims the request', async () => {
    const { client, responses, send } = harness()
    client.onRequest('m', () => REQUEST_NOT_HANDLED)

    await send('m', { threadId: 'orphan' })

    expect(responses[0].result).toBeUndefined()
    expect(responses[0].error).toMatchObject({ code: -32000 })
  })

  it('unregisters one handler without disturbing the others', async () => {
    const { client, responses, send } = harness()
    const kept = vi.fn(() => ({ ok: true }))
    const unregister = client.onRequest('m', () => ({ ok: false }))
    client.onRequest('m', kept)
    unregister()

    await send('m', {})

    expect(responses[0].result).toEqual({ ok: true })
  })
})

describe('app-server connection sharing', () => {
  it('hands the same connection to every session on a host', () => {
    const a = acquireAppServerClient(settings())
    const b = acquireAppServerClient(settings())
    try {
      expect(b.client).toBe(a.client)
    } finally {
      a.release()
      b.release()
    }
  })

  it('keeps the connection alive until the last holder lets go', () => {
    const a = acquireAppServerClient(settings())
    const b = acquireAppServerClient(settings())
    const dispose = vi.spyOn(a.client, 'dispose')

    a.release()
    expect(dispose).not.toHaveBeenCalled()

    b.release()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('ignores a double release so one session cannot drop another', () => {
    const a = acquireAppServerClient(settings())
    const b = acquireAppServerClient(settings())
    const dispose = vi.spyOn(a.client, 'dispose')

    a.release()
    a.release()
    expect(dispose).not.toHaveBeenCalled()

    b.release()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('shares one host connection despite different environment and binary settings', () => {
    const a = acquireAppServerClient(settings())
    const b = acquireAppServerClient(settings({ codexPath: '/other/codex', env: { OPERON_TEST: '1' } }))
    try {
      expect(b.client).toBe(a.client)
    } finally {
      a.release()
      b.release()
    }
  })

  it('keeps different hosts separate', () => {
    const a = acquireAppServerClient(settings())
    const b = acquireAppServerClient(settings(), 'remote')
    expect(b.client).not.toBe(a.client)
    a.release()
    b.release()
  })

  it('does not remove a new connection when an old lease releases after disposal', () => {
    const old = acquireAppServerClient(settings())
    disposeAllAppServerClients()
    const current = acquireAppServerClient(settings())
    old.release()
    const next = acquireAppServerClient(settings())
    expect(next.client).toBe(current.client)
    current.release()
    next.release()
  })

  it('shares across workspaces — cwd travels with the thread, not the process', () => {
    const a = acquireAppServerClient(settings({ cwd: '/repo/one' }))
    const b = acquireAppServerClient(settings({ cwd: '/repo/two' }))
    try {
      expect(b.client).toBe(a.client)
    } finally {
      a.release()
      b.release()
    }
  })

  it('opens a fresh connection after the previous one was released', () => {
    const first = acquireAppServerClient(settings())
    first.release()
    const second = acquireAppServerClient(settings())
    try {
      expect(second.client).not.toBe(first.client)
    } finally {
      second.release()
      disposeAllAppServerClients()
    }
  })
})

describe('account queries and discovery share the conversation connection', () => {
  it.each(['usage first', 'conversation first'])('%s retains one client until runtime and chats release it', async (order) => {
    const ctx = createRuntimeContext({
      resolveBinary: () => '/usr/local/bin/codex',
      env: () => ({ OPERON_TEST: 'usage' }),
    })
    const readUsage = vi.spyOn(AppServerClient.prototype, 'readRateLimits').mockResolvedValue(null)
    if (order === 'usage first') await getCodexAccountUsage(ctx)
    const chat = acquireAppServerClient(settings({ cwd: '/repo/one', env: { OPERON_TEST: 'chat' } }))
    const otherChat = acquireAppServerClient(settings({ cwd: '/repo/two' }))
    if (order === 'conversation first') await getCodexAccountUsage(ctx)
    expect(readUsage.mock.instances[0]).toBe(chat.client)
    expect(otherChat.client).toBe(chat.client)
    const dispose = vi.spyOn(chat.client, 'dispose')
    chat.release()
    otherChat.release()
    expect(dispose).not.toHaveBeenCalled()
    await getCodexAccountUsage(ctx)
    expect(readUsage.mock.instances[1]).toBe(chat.client)
    await ctx.disposeShared()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('borrows the conversation client for model and skill discovery without disposing it', async () => {
    const chat = acquireAppServerClient(settings())
    const models = vi.spyOn(chat.client, 'listModels').mockResolvedValue({ data: [], nextCursor: null })
    const skills = vi.spyOn(chat.client, 'listSkills').mockResolvedValue({ data: [] })
    const dispose = vi.spyOn(chat.client, 'dispose')
    await expect(listModels({ env: { OPERON_TEST: 'models' } })).resolves.toEqual({ models: [], defaultModel: undefined })
    await expect(listSkills({ cwds: ['/repo/two'] })).resolves.toEqual([])
    expect(models).toHaveBeenCalledOnce()
    expect(skills).toHaveBeenCalledWith({ cwds: ['/repo/two'] })
    expect(dispose).not.toHaveBeenCalled()
    models.mockRejectedValueOnce(new Error('discovery failed'))
    await expect(listModels()).rejects.toThrow('discovery failed')
    expect(dispose).not.toHaveBeenCalled()
    chat.release()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
