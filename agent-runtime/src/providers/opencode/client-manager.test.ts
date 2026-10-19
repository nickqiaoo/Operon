import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeContext } from '../../context.js'

const { startServer, createClient, closeServer } = vi.hoisted(() => {
  const closeServer = vi.fn()
  return {
    closeServer,
    startServer: vi.fn(async () => ({ url: 'http://127.0.0.1:12345', close: closeServer })),
    createClient: vi.fn(() => ({})),
  }
})

vi.mock('./server.js', () => ({ startOpencodeServer: startServer }))
vi.mock('@opencode-ai/sdk/v2', () => ({ createOpencodeClient: createClient }))
vi.mock('./caller-identity.js', () => ({ writeOpencodeCallerPlugin: () => 'file:///caller-identity.mjs' }))
vi.mock('./server-pidfile.js', () => ({
  reapOrphanedServers: vi.fn(), pidListeningOn: vi.fn(), recordServer: vi.fn(), forgetServer: vi.fn(),
}))

import { OpencodeClientManager } from './client-manager.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('OpenCode Code Mode startup', () => {
  it('enables Code Mode on the managed server while preserving caller identity', async () => {
    vi.stubEnv('OPENCODE_EXPERIMENTAL_CODE_MODE', undefined)
    const ctx = createRuntimeContext({ resolveBinary: () => '/test/opencode' })
    const manager = OpencodeClientManager.getInstance(ctx)
    await manager.getClient()
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
      binary: '/test/opencode',
      env: expect.objectContaining({ OPENCODE_EXPERIMENTAL_CODE_MODE: 'true' }),
      config: { plugin: ['file:///caller-identity.mjs'] },
    }))
    await ctx.disposeShared()
    expect(closeServer).toHaveBeenCalledOnce()
  })

  it('preserves an explicit host opt-out', async () => {
    const ctx = createRuntimeContext({ env: () => ({ OPENCODE_EXPERIMENTAL_CODE_MODE: 'false' }) })
    await OpencodeClientManager.getInstance(ctx).getClient()
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({ OPENCODE_EXPERIMENTAL_CODE_MODE: 'false' }),
    }))
    await ctx.disposeShared()
  })
})
