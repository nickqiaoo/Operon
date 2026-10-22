import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import { createRuntimeContext } from '../../context.js'
import { AcpRuntimeSession } from './session.js'
import type { AcpSessionCallbacks } from './connection.js'
import { buildAcpDescriptor } from './discovery.js'
import type { AcpProviderConfig } from './types.js'

const acquire = vi.hoisted(() => vi.fn())
vi.mock('./connection-registry.js', () => ({ acquireAcpConnection: acquire, disposeAllAcpConnections: vi.fn() }))

const config: AcpProviderConfig = {
  providerId: 'test', cliId: 'test', label: 'Test', logo: 'test', agentArgs: [], fallbackCommand: 'test',
  defaultModelId: 'old-default', defaultModeId: 'default', modes: [], modelProbe: 'session',
  features: { permissions: true, attachments: false, injection: false, sessionResume: true },
  extractModels: () => ({ models: [], currentModelId: 'old-default' }),
}
const select = (id: string, category: string, currentValue: string, values: string[]): acp.SessionConfigOption => ({
  id, name: id, category, type: 'select', currentValue,
  options: values.map(value => ({ value, name: value })),
})
const defaults = (): acp.SessionConfigOption[] => [
  select('model', 'model', 'model-a', ['model-a', 'model-b']),
  select('reasoning_effort', 'thought_level', 'high', ['low', 'high', 'xhigh']),
]
function harness(options: acp.SessionConfigOption[] | null = defaults()) {
  let callbacks: AcpSessionCallbacks | undefined
  let current = options ?? []
  const setConfig = vi.fn(async (params: acp.SetSessionConfigOptionRequest) => {
    current = current.map(option => option.id === params.configId ? { ...option, currentValue: params.value } as acp.SessionConfigOption : option)
    if (params.configId === 'model' && params.value === 'model-b') {
      current = [current[0], select('reasoning_effort', 'thought_level', 'low', ['low', 'high'])]
    }
    return { configOptions: current }
  })
  const request = vi.fn(async () => ({}))
  const prompt = vi.fn(async () => ({ stopReason: 'end_turn' as const }))
  acquire.mockResolvedValue({
    connection: {
      agent: { newSession: vi.fn(async () => ({ sessionId: 's', configOptions: options ?? undefined })),
        loadSession: vi.fn(async () => ({ configOptions: options ?? undefined })), setSessionConfigOption: setConfig, request, prompt },
      registerSession: (_id: string, cb: AcpSessionCallbacks) => { callbacks = cb; return () => {} },
    },
    initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true } }, release: vi.fn(),
  })
  return { setConfig, request, prompt, update: (next: acp.SessionConfigOption[]) => callbacks?.onSessionUpdate({
    sessionId: 's', update: { sessionUpdate: 'config_option_update', configOptions: next },
  }) }
}
const ctx = createRuntimeContext()
beforeEach(() => acquire.mockReset())

describe('ACP session configuration', () => {
  it('applies initial effort before the first prompt and reads the actual default model', async () => {
    const h = harness()
    const session = new AcpRuntimeSession({ cwd: '/tmp', effort: 'xhigh' }, config, ctx)
    for await (const _part of session.send('hello')) { /* drain */ }
    expect(h.setConfig).toHaveBeenCalledWith({ sessionId: 's', configId: 'reasoning_effort', value: 'xhigh' })
    expect(h.setConfig.mock.invocationCallOrder[0]).toBeLessThan(h.prompt.mock.invocationCallOrder[0])
    expect(session.state()).toMatchObject({ currentModelId: 'model-a', currentThinkingLevel: 'xhigh' })
  })

  it('uses the config id advertised by the agent and handles grouped options', async () => {
    const h = harness([{ id: 'thinking_level', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: 'high',
      options: [{ group: 'levels', name: 'Levels', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }] }])
    const session = new AcpRuntimeSession({ cwd: '/tmp' }, config, ctx)
    expect(await session.set({ effort: 'low' })).toEqual(['effort'])
    expect(h.setConfig).toHaveBeenCalledWith({ sessionId: 's', configId: 'thinking_level', value: 'low' })
    expect(session.state().thinkingLevels).toEqual([{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }])
  })

  it('refreshes effort choices after changing model and validates against the new list', async () => {
    const h = harness()
    const session = new AcpRuntimeSession({ cwd: '/tmp' }, config, ctx)
    expect(await session.set({ model: 'model-b', effort: 'high' })).toEqual(['model', 'effort'])
    expect(session.state().thinkingLevels?.map(level => level.id)).toEqual(['low', 'high'])
    await expect(session.set({ effort: 'xhigh' })).rejects.toThrow('Unsupported')
    expect(h.setConfig).toHaveBeenCalledTimes(2)
  })

  it('updates state on idle notifications, including removing an effort selector', async () => {
    const h = harness()
    const session = new AcpRuntimeSession({ cwd: '/tmp' }, config, ctx)
    await session.set({})
    h.update([select('effort', 'thought_level', 'low', ['low'])])
    expect(session.state().currentThinkingLevel).toBe('low')
    h.update([])
    expect(session.state()).toMatchObject({ thinkingLevels: [], currentThinkingLevel: undefined })
  })

  it('does not report rejected or unconfirmed changes as applied', async () => {
    const h = harness()
    const session = new AcpRuntimeSession({ cwd: '/tmp' }, config, ctx)
    await session.set({})
    h.setConfig.mockRejectedValueOnce(new Error('Rejected'))
    await expect(session.set({ effort: 'low' })).rejects.toThrow('Rejected')
    expect(session.state().currentThinkingLevel).toBe('high')
    h.setConfig.mockResolvedValueOnce({ configOptions: defaults() })
    expect(await session.set({ effort: 'low' })).toEqual([])
    expect(session.state().currentThinkingLevel).toBe('high')
  })

  it('does not prompt or bypass a failed initial effort on the next send', async () => {
    const h = harness()
    h.setConfig.mockResolvedValue({ configOptions: defaults() })
    const session = new AcpRuntimeSession({ cwd: '/tmp', effort: 'low' }, config, ctx)
    const send = async () => { for await (const _part of session.send('hello')) { /* drain */ } }
    await expect(send()).rejects.toThrow('did not apply reasoning effort')
    await expect(send()).rejects.toThrow('did not apply reasoning effort')
    expect(h.prompt).not.toHaveBeenCalled()
  })

  it('loads config state on resume before applying the requested effort', async () => {
    const h = harness()
    const session = new AcpRuntimeSession({ cwd: '/tmp', resume: 's', effort: 'low' }, config, ctx)
    await session.set({})
    expect(h.setConfig).toHaveBeenCalledWith({ sessionId: 's', configId: 'reasoning_effort', value: 'low' })
    expect(session.state().currentThinkingLevel).toBe('low')
  })

  it('keeps legacy model switching and does not invent effort support', async () => {
    const h = harness(null)
    // Explicitly emulate a legacy session response without configOptions.
    const session = new AcpRuntimeSession({ cwd: '/tmp' }, config, ctx)
    // No effort option is advertised even on an empty modern config response.
    await session.set({})
    h.update([])
    expect(await session.set({ model: 'legacy-model' })).toEqual(['model'])
    expect(h.request).toHaveBeenCalledWith('session/set_model', { sessionId: 's', modelId: 'legacy-model' })
    await expect(session.set({ effort: 'high' })).rejects.toThrow('does not offer reasoning effort')
  })

  it('exposes discovered effort choices to the existing model endpoint', () => {
    const descriptor = buildAcpDescriptor(config, { models: [], currentModelId: 'old-default', currentModeId: 'default' }, {
      initialize: null, session: { sessionId: 's', configOptions: defaults() }, commands: null,
    })
    expect(descriptor.currentModelId).toBe('model-a')
    expect(descriptor.thinkingLevels?.map(level => level.id)).toEqual(['low', 'high', 'xhigh'])
    expect(descriptor.currentThinkingLevel).toBe('high')
    expect(descriptor.features.dynamicSwitch).toBe(true)
  })
})
