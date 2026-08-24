import { describe, expect, it, vi } from 'vitest'
import { SessionManager } from './session-manager.js'
import type { RuntimeProviderFactory, RuntimeSession } from './types.js'

const createRuntime = (resolvePermission: RuntimeSession['resolvePermission']): RuntimeSession => ({
  async *stream() {},
  abort() {},
  async dispose() {},
  resolvePermission,
})

describe('SessionManager permission resolution', () => {
  it('returns the runtime result instead of treating every existing session as resolved', async () => {
    const resolvePermission = vi.fn<RuntimeSession['resolvePermission']>().mockReturnValue(false)
    const runtime = createRuntime(resolvePermission)
    const provider: RuntimeProviderFactory = {
      providerInfo: { id: 'approval-test', label: 'Approval Test', logo: '' },
      async getDescriptor() {
        throw new Error('not needed')
      },
      async createSession() {
        return runtime
      },
    }
    const manager = new SessionManager()
    manager.register('approval-test', () => provider, provider.providerInfo)
    await manager.getOrCreate(42, 'approval-test', { cwd: '/tmp' })

    const decision = { type: 'allow' as const }
    expect(manager.resolvePermission(42, 'stale-approval', decision)).toBe(false)
    expect(resolvePermission).toHaveBeenCalledWith('stale-approval', decision)

    resolvePermission.mockReturnValue(true)
    expect(manager.resolvePermission(42, 'pending-approval', decision)).toBe(true)
  })
})
