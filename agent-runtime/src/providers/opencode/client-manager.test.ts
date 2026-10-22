import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeContext } from '../../context.js'

const { startServer, createClient, closeServer } = vi.hoisted(() => {
  const closeServer = vi.fn()
  return {
    closeServer,
    startServer: vi.fn(async () => ({ url: 'http://127.0.0.1:12345', headers: { Authorization: 'Basic fixture' }, close: closeServer })),
    createClient: vi.fn(() => ({})),
  }
})

vi.mock('./server.js', () => ({ startOpencodeServer: startServer }))
vi.mock('@opencode/client', () => ({ OpenCode: { make: createClient } }))
vi.mock('./caller-identity.js', () => ({ writeOpencodeCallerPlugin: () => 'file:///caller-identity.mjs' }))
vi.mock('./server-pidfile.js', () => ({
  reapOrphanedServers: vi.fn(), pidListeningOn: vi.fn(), recordServer: vi.fn(), forgetServer: vi.fn(),
}))

import { OpencodeClientManager } from './client-manager.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('OpenCode V2 startup', () => {
  it('authenticates the native client and loads the caller identity plugin', async () => {
    const ctx = createRuntimeContext({ resolveBinary: () => '/test/opencode' })
    const manager = OpencodeClientManager.getInstance(ctx)
    await manager.getClient()
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
      binary: '/test/opencode',
      config: { plugins: ['file:///caller-identity.mjs'] },
    }))
    expect(createClient).toHaveBeenCalledWith({ baseUrl: 'http://127.0.0.1:12345', headers: { Authorization: 'Basic fixture' } })
    await ctx.disposeShared()
    expect(closeServer).toHaveBeenCalledOnce()
  })

  it('passes the host environment to the managed server', async () => {
    const ctx = createRuntimeContext({ env: () => ({ OPENCODE_DISABLE_MODELS_FETCH: 'true' }) })
    await OpencodeClientManager.getInstance(ctx).getClient()
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({ OPENCODE_DISABLE_MODELS_FETCH: 'true' }),
    }))
    await ctx.disposeShared()
  })
})
