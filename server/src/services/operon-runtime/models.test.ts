import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfigs, ProviderModel } from '../provider-config.js'

const state = vi.hoisted(() => ({
  configs: {} as ProviderConfigs,
  fetch: vi.fn<(id: string) => Promise<ProviderModel[]>>(),
}))

vi.mock('../provider-config.js', () => ({
  getProviderConfigs: () => state.configs,
  getProviderMeta: (id: string) => ({ label: state.configs[id]?.custom?.name ?? id }),
  isProviderUsable: (_id: string, config: ProviderConfigs[string]) => !!config.apiKey || !!config.baseUrl,
  fetchProviderModels: (id: string) => state.fetch(id),
}))
vi.mock('./resolve-model.js', () => ({
  getModelCapabilities: () => ({ effortLevels: [] }),
}))

async function setup() {
  vi.resetModules()
  return (await import('./models.js')).availableModels
}

beforeEach(() => {
  state.configs = { openai: { enabled: true, apiKey: 'key' } }
  state.fetch.mockReset().mockImplementation(async (id) => [{ id: `${id}-model`, name: id }])
})

describe('Operon model catalog', () => {
  it('retains existing providers when a new provider is enabled without fetching them again', async () => {
    const list = await setup()
    await list()
    state.configs['custom-new'] = { enabled: true, baseUrl: 'https://new.example', manualModels: ['manual'] }
    // The old behavior would refetch openai here and lose it on this transient failure.
    state.fetch.mockImplementation(async (id) => {
      if (id === 'openai') throw new Error('Temporarily unavailable')
      return [{ id: 'live', name: 'Live' }]
    })
    expect((await list()).map((m) => m.id)).toEqual(['openai/openai-model', 'custom-new/manual', 'custom-new/live'])
    expect(state.fetch.mock.calls.map(([id]) => id)).toEqual(['openai', 'custom-new'])
  })

  it('keeps the last successful list when a stale endpoint fails, then accepts a successful empty list', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    try {
      const list = await setup()
      await list()
      now.mockReturnValue(160_001)
      state.fetch.mockRejectedValueOnce(new Error('Network error'))
      expect((await list()).map((m) => m.id)).toEqual(['openai/openai-model'])
      now.mockReturnValue(220_002)
      state.fetch.mockResolvedValueOnce([])
      expect(await list()).toEqual([])
    } finally {
      now.mockRestore()
    }
  })

  it('removes disabled or deleted providers immediately and fetches again on re-enable', async () => {
    const list = await setup()
    await list()
    state.configs.openai!.enabled = false
    expect(await list()).toEqual([])
    state.configs.openai!.enabled = true
    expect(await list()).toHaveLength(1)
    expect(state.fetch).toHaveBeenCalledTimes(2)
    delete state.configs.openai
    expect(await list()).toEqual([])
  })

  it('refreshes changed credentials without reusing models from the previous endpoint', async () => {
    const list = await setup()
    await list()
    state.configs.openai!.baseUrl = 'https://different.example'
    state.fetch.mockRejectedValueOnce(new Error('Unavailable'))
    expect(await list()).toEqual([])
    expect(state.fetch).toHaveBeenCalledTimes(2)
  })

  it('updates manual models and labels immediately without refetching the endpoint', async () => {
    const list = await setup()
    await list()
    state.configs.openai!.manualModels = ['manual', 'openai-model']
    state.configs.openai!.custom = { name: 'Renamed', api: 'openai-completions' }
    await list() // changing the wire API refreshes the endpoint
    state.configs.openai!.custom.name = 'New label'
    state.configs.openai!.manualModels = ['other', 'openai-model']
    const models = await list()
    expect(models.map((m) => m.id)).toEqual(['openai/other', 'openai/openai-model'])
    expect(models.every((m) => m.providerLabel === 'New label')).toBe(true)
    expect(state.fetch).toHaveBeenCalledTimes(2)
  })

  it('deduplicates concurrent requests and never exposes a partial aggregate', async () => {
    const list = await setup()
    let resolveModels!: (models: ProviderModel[]) => void
    state.fetch.mockReturnValue(new Promise<ProviderModel[]>((resolve) => { resolveModels = resolve }))
    const first = list()
    const second = list()
    expect(state.fetch).toHaveBeenCalledTimes(1)
    resolveModels([{ id: 'complete', name: 'Complete' }])
    expect((await first).map((m) => m.id)).toEqual(['openai/complete'])
    expect(await second).toEqual(await first)
  })

  it('ignores an old in-flight response after the endpoint config changes', async () => {
    const list = await setup()
    let resolveOld!: (models: ProviderModel[]) => void
    state.fetch.mockReturnValueOnce(new Promise<ProviderModel[]>((resolve) => { resolveOld = resolve }))
    const old = list()
    state.configs.openai = { enabled: true, apiKey: 'new-key' }
    state.fetch.mockResolvedValue([{ id: 'new', name: 'New' }])
    await list()
    resolveOld([{ id: 'old', name: 'Old' }])
    await old
    expect((await list()).map((m) => m.id)).toEqual(['openai/new'])
  })
})
