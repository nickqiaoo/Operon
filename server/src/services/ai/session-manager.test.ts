import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionManager } from './session-manager.js'
import {
  createRuntime,
  defineProvider,
  type AgentSession,
  type RuntimeProviderFactory,
  type SessionOptions,
  type SessionPatch,
  type SessionPatchApplied,
} from '@operon/agent-runtime'

const createAgentSession = (respond: AgentSession['respond']): AgentSession => ({
  id: undefined,
  async *send() {},
  abort() {},
  async close() {},
  respond,
})

describe('SessionManager permission resolution', () => {
  it('returns the runtime result instead of treating every existing session as resolved', async () => {
    const resolvePermission = vi.fn<AgentSession['respond']>().mockReturnValue(false)
    const runtime = createAgentSession(resolvePermission)
    const provider: RuntimeProviderFactory = {
      providerInfo: { id: 'approval-test', label: 'Approval Test', logo: '' },
      async getDescriptor() {
        throw new Error('not needed')
      },
      async createSession() {
        return runtime
      },
    }
    const manager = new SessionManager(createRuntime({
      providers: [defineProvider({ id: 'approval-test', info: provider.providerInfo, create: () => provider })],
    }))
    await manager.getOrCreate(42, 'approval-test', { cwd: '/tmp' })

    const decision = { type: 'allow' as const }
    expect(manager.resolvePermission(42, 'stale-approval', decision)).toBe(false)
    expect(resolvePermission).toHaveBeenCalledWith('stale-approval', decision)

    resolvePermission.mockReturnValue(true)
    expect(manager.resolvePermission(42, 'pending-approval', decision)).toBe(true)
  })
})

interface StubOptions {
  set?: AgentSession['set']
  close?: AgentSession['close']
}

function stubProvider(options: StubOptions = {}) {
  const created: SessionOptions[] = []
  const provider: RuntimeProviderFactory = {
    providerInfo: { id: 'stub', label: 'Stub', logo: '' },
    async getDescriptor() {
      throw new Error('not needed')
    },
    async createSession(params) {
      created.push(params)
      return {
        id: undefined,
        async *send() {},
        abort() {},
        close: options.close ?? (async () => {}),
        respond: () => false,
        ...(options.set ? { set: options.set } : {}),
      }
    },
  }
  const manager = new SessionManager(createRuntime({
    providers: [defineProvider({ id: 'stub', info: provider.providerInfo, create: () => provider })],
  }))
  return { manager, created }
}

/** A provider that takes every field it is handed. */
const acceptAll = vi.fn(async (payload: SessionPatch) => {
  const applied: SessionPatchApplied = []
  for (const field of ['model', 'mode', 'effort', 'serviceTier'] as const) {
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
    const { manager, created } = stubProvider({ set: acceptAll })

    const before = await manager.getOrCreate(1, 'stub', { cwd: '/tmp' })
    const after = await manager.getOrCreate(1, 'stub', { cwd: '/tmp', serviceTier: 'fast' })

    expect(after.runtime).toBe(before.runtime)
    expect(created).toHaveLength(1)
    expect(acceptAll).toHaveBeenCalledWith({ serviceTier: 'fast' })
  })

  it('forwards fast mode being switched off, rather than reading it as unspecified', async () => {
    const { manager, created } = stubProvider({ set: acceptAll })

    await manager.getOrCreate(1, 'stub', { cwd: '/tmp', serviceTier: 'fast' })
    await manager.getOrCreate(1, 'stub', { cwd: '/tmp' })

    // The payload must CARRY serviceTier: dropping it as "nothing asked for"
    // would leave the session fast with no way back.
    expect(acceptAll).toHaveBeenCalledWith({ serviceTier: undefined })
    expect(created).toHaveLength(1)
  })

  it('keeps the session across model, mode and effort updates and later turns', async () => {
    const { manager, created } = stubProvider({ set: acceptAll })
    const before = await manager.getOrCreate(1, 'stub', {
      cwd: '/tmp', model: 'm1', mode: 'default', effort: 'low',
    })
    const next = { cwd: '/tmp', model: 'm2', mode: 'plan', effort: 'high' }

    const after = await manager.getOrCreate(1, 'stub', next)
    expect(after.runtime).toBe(before.runtime)
    expect(acceptAll).toHaveBeenCalledWith({ model: 'm2', mode: 'plan', effort: 'high' })

    await manager.getOrCreate(1, 'stub', next)
    expect(acceptAll).toHaveBeenCalledTimes(1)
    expect(created).toHaveLength(1)
  })

  it('does not repeat live updates or rebuild when the next message arrives', async () => {
    const { manager, created } = stubProvider({ set: acceptAll })
    const before = await manager.getOrCreate(1, 'stub', {
      cwd: '/tmp', effort: 'low', serviceTier: 'fast',
    })
    const patch: SessionPatch = { effort: 'high', serviceTier: undefined }
    const applied = await before.runtime.set!(patch)
    manager.applyDynamicParams(1, patch, applied)

    const after = await manager.getOrCreate(1, 'stub', { cwd: '/tmp', effort: 'high' })
    expect(after.runtime).toBe(before.runtime)
    expect(acceptAll).toHaveBeenCalledTimes(1)
    expect(created).toHaveLength(1)
  })

  it('rebuilds when the provider cannot take a fast-mode change', async () => {
    const refuse = vi.fn(async () => [] as SessionPatchApplied)
    const { manager, created } = stubProvider({ set: refuse })

    const before = await manager.getOrCreate(1, 'stub', { cwd: '/tmp' })
    const after = await manager.getOrCreate(1, 'stub', { cwd: '/tmp', serviceTier: 'fast' })

    expect(refuse).toHaveBeenCalledWith({ serviceTier: 'fast' })
    expect(after.runtime).not.toBe(before.runtime)
    expect(created).toHaveLength(2)
  })

  it('reads a missing model as "unchanged", not as a change to nothing', async () => {
    const { manager, created } = stubProvider({ set: acceptAll })

    await manager.getOrCreate(1, 'stub', { cwd: '/tmp', model: 'm1' })
    await manager.getOrCreate(1, 'stub', { cwd: '/tmp' })

    expect(acceptAll).not.toHaveBeenCalled()
    expect(created).toHaveLength(1)
  })

  it('tells a structurally-replaced session that a rebuild is coming, not a discard', async () => {
    const close = vi.fn(async () => {})
    const { manager } = stubProvider({ close })

    await manager.getOrCreate(1, 'stub', { cwd: '/tmp' })
    await manager.getOrCreate(1, 'stub', { cwd: '/elsewhere' })

    expect(close).toHaveBeenCalledWith('rebuild')

    await manager.destroy(1)
    expect(close).toHaveBeenLastCalledWith('discard')
  })
})
