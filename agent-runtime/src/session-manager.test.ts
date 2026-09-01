import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionManager } from './session-manager.js'
import type {
  DynamicSetApplied,
  DynamicSetPayload,
  RuntimeProviderFactory,
  RuntimeSession,
  RuntimeSessionParams,
} from './types.js'

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

interface StubOptions {
  dynamicSet?: RuntimeSession['dynamicSet']
  dispose?: RuntimeSession['dispose']
}

function stubProvider(options: StubOptions = {}) {
  const created: RuntimeSessionParams[] = []
  const provider: RuntimeProviderFactory = {
    providerInfo: { id: 'stub', label: 'Stub', logo: '' },
    async getDescriptor() {
      throw new Error('not needed')
    },
    async createSession(params) {
      created.push(params)
      return {
        async *stream() {},
        abort() {},
        dispose: options.dispose ?? (async () => {}),
        resolvePermission: () => false,
        ...(options.dynamicSet ? { dynamicSet: options.dynamicSet } : {}),
      }
    },
  }
  const manager = new SessionManager()
  manager.register('stub', () => provider, provider.providerInfo)
  return { manager, created }
}

/** A provider that takes every field it is handed. */
const acceptAll = vi.fn(async (payload: DynamicSetPayload) => {
  const applied: DynamicSetApplied = []
  for (const field of ['modelId', 'modeId', 'thinkingLevel', 'serviceTier'] as const) {
    if (field in payload) applied.push(field)
  }
  return applied
})

describe('SessionManager reconfigure', () => {
  // Braces matter: an arrow returning `mockClear()` hands vitest the mock itself,
  // which it then treats as a teardown callback and calls with no arguments.
  beforeEach(() => {
    acceptAll.mockClear()
  })

  it('keeps the session when the provider takes a fast-mode change', async () => {
    const { manager, created } = stubProvider({ dynamicSet: acceptAll })

    const before = await manager.getOrCreate(1, 'stub', { cwd: '/tmp' })
    const after = await manager.getOrCreate(1, 'stub', { cwd: '/tmp', serviceTier: 'fast' })

    expect(after.runtime).toBe(before.runtime)
    expect(created).toHaveLength(1)
    expect(acceptAll).toHaveBeenCalledWith({ serviceTier: 'fast' })
  })

  it('forwards fast mode being switched off, rather than reading it as unspecified', async () => {
    const { manager, created } = stubProvider({ dynamicSet: acceptAll })

    await manager.getOrCreate(1, 'stub', { cwd: '/tmp', serviceTier: 'fast' })
    await manager.getOrCreate(1, 'stub', { cwd: '/tmp' })

    // The payload must CARRY serviceTier: dropping it as "nothing asked for"
    // would leave the session fast with no way back.
    expect(acceptAll).toHaveBeenCalledWith({ serviceTier: undefined })
    expect(created).toHaveLength(1)
  })

  it('rebuilds when the provider cannot take a fast-mode change', async () => {
    const refuse = vi.fn(async () => [] as DynamicSetApplied)
    const { manager, created } = stubProvider({ dynamicSet: refuse })

    const before = await manager.getOrCreate(1, 'stub', { cwd: '/tmp' })
    const after = await manager.getOrCreate(1, 'stub', { cwd: '/tmp', serviceTier: 'fast' })

    expect(refuse).toHaveBeenCalledWith({ serviceTier: 'fast' })
    expect(after.runtime).not.toBe(before.runtime)
    expect(created).toHaveLength(2)
  })

  it('reads a missing model as "unchanged", not as a change to nothing', async () => {
    const { manager, created } = stubProvider({ dynamicSet: acceptAll })

    await manager.getOrCreate(1, 'stub', { cwd: '/tmp', modelId: 'm1' })
    await manager.getOrCreate(1, 'stub', { cwd: '/tmp' })

    expect(acceptAll).not.toHaveBeenCalled()
    expect(created).toHaveLength(1)
  })

  it('tells a structurally-replaced session that a rebuild is coming, not a discard', async () => {
    const dispose = vi.fn(async () => {})
    const { manager } = stubProvider({ dispose })

    await manager.getOrCreate(1, 'stub', { cwd: '/tmp' })
    await manager.getOrCreate(1, 'stub', { cwd: '/elsewhere' })

    expect(dispose).toHaveBeenCalledWith('rebuild')

    await manager.destroy(1)
    expect(dispose).toHaveBeenLastCalledWith('discard')
  })
})
