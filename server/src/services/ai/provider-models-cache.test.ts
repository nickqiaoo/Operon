import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderDescriptor } from '@operon/agent-runtime'

const helpersMock = vi.hoisted(() => ({
  getProviderBaseDescriptor: vi.fn(),
  getProviderDescriptorPatch: vi.fn(),
}))

vi.mock('./helpers.js', () => ({
  getProviderBaseDescriptor: helpersMock.getProviderBaseDescriptor,
  getProviderDescriptorPatch: helpersMock.getProviderDescriptorPatch,
}))

import {
  getProviderModelsCached,
  invalidateProviderModels,
} from './provider-models-cache.js'

const descriptor = (
  providerId: string,
  modelIds: string[],
  modelsPending = false,
): ProviderDescriptor => ({
  id: providerId,
  label: providerId,
  logo: providerId,
  models: modelIds.map((id) => ({ id, name: id })),
  ...(modelsPending ? { modelsPending: true } : {}),
  modes: [],
  commands: [],
  currentModelId: modelIds[0] ?? '',
  currentModeId: '',
  features: {
    permissions: false,
    attachments: false,
    injection: false,
    sessionResume: false,
  },
})

describe('provider models cache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T00:00:00Z'))
    helpersMock.getProviderBaseDescriptor.mockReset()
    helpersMock.getProviderDescriptorPatch.mockReset()
    helpersMock.getProviderDescriptorPatch.mockReturnValue(undefined)
    invalidateProviderModels()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('serves a fresh cache hit without fetching the provider again', async () => {
    helpersMock.getProviderBaseDescriptor.mockResolvedValue(descriptor('copilot', ['gpt-5']))

    const first = await getProviderModelsCached('copilot')
    const second = await getProviderModelsCached('copilot')

    expect(first.models).toEqual([{ modelId: 'gpt-5', name: 'gpt-5', providerId: undefined }])
    expect(second).toEqual(first)
    expect(helpersMock.getProviderBaseDescriptor).toHaveBeenCalledTimes(1)
  })

  it('overlays a live session patch without refetching the cached provider descriptor', async () => {
    helpersMock.getProviderBaseDescriptor.mockResolvedValue(descriptor('copilot', ['gpt-5']))

    const base = await getProviderModelsCached('copilot')
    expect(base.slashCommands).toEqual([])

    helpersMock.getProviderDescriptorPatch.mockReturnValue({
      currentModeId: 'plan',
      slashCommands: [
        { name: 'review', description: 'Review changes', type: 'skill' },
      ],
    })
    const patched = await getProviderModelsCached('copilot')

    expect(patched.currentModeId).toBe('plan')
    expect(patched.slashCommands).toEqual([
      { name: 'review', description: 'Review changes', type: 'skill' },
    ])
    expect(helpersMock.getProviderBaseDescriptor).toHaveBeenCalledTimes(1)
  })

  it('returns stale data immediately and revalidates it in the background', async () => {
    helpersMock.getProviderBaseDescriptor
      .mockResolvedValueOnce(descriptor('copilot', ['old-model']))
      .mockResolvedValueOnce(descriptor('copilot', ['new-model']))

    await getProviderModelsCached('copilot')
    vi.advanceTimersByTime(60_001)

    const stale = await getProviderModelsCached('copilot')
    expect(stale.models[0]?.modelId).toBe('old-model')
    expect(helpersMock.getProviderBaseDescriptor).toHaveBeenCalledTimes(2)

    await vi.waitFor(async () => {
      const fresh = await getProviderModelsCached('copilot')
      expect(fresh.models[0]?.modelId).toBe('new-model')
    })
  })

  it('deduplicates concurrent cold fetches for the same provider', async () => {
    let resolveDescriptor: ((value: ProviderDescriptor) => void) | undefined
    helpersMock.getProviderBaseDescriptor.mockReturnValue(new Promise<ProviderDescriptor>((resolve) => {
      resolveDescriptor = resolve
    }))

    const first = getProviderModelsCached('copilot')
    const second = getProviderModelsCached('copilot')

    expect(helpersMock.getProviderBaseDescriptor).toHaveBeenCalledTimes(1)
    resolveDescriptor?.(descriptor('copilot', ['gpt-5']))

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(helpersMock.getProviderBaseDescriptor).toHaveBeenCalledTimes(1)
  })

  it('invalidates one provider without evicting the others', async () => {
    helpersMock.getProviderBaseDescriptor.mockImplementation(async (providerId: string) => (
      descriptor(providerId, [`${providerId}-model`])
    ))

    await getProviderModelsCached('copilot')
    await getProviderModelsCached('claude-code')
    invalidateProviderModels('copilot')

    await getProviderModelsCached('copilot')
    await getProviderModelsCached('claude-code')

    expect(helpersMock.getProviderBaseDescriptor).toHaveBeenCalledTimes(3)
  })

  it('does not let a pre-invalidation refresh overwrite the new generation', async () => {
    let resolveOldDescriptor: ((value: ProviderDescriptor) => void) | undefined
    helpersMock.getProviderBaseDescriptor
      .mockReturnValueOnce(new Promise<ProviderDescriptor>((resolve) => {
        resolveOldDescriptor = resolve
      }))
      .mockResolvedValueOnce(descriptor('copilot', ['new-model']))

    const oldRequest = getProviderModelsCached('copilot')
    invalidateProviderModels('copilot')
    const newRequest = getProviderModelsCached('copilot')

    resolveOldDescriptor?.(descriptor('copilot', ['old-model']))

    await expect(newRequest).resolves.toMatchObject({
      models: [{ modelId: 'new-model' }],
    })
    await expect(oldRequest).resolves.toMatchObject({
      models: [{ modelId: 'new-model' }],
    })
    expect(helpersMock.getProviderBaseDescriptor).toHaveBeenCalledTimes(2)
  })

  it('marks an empty first result as pending and retries it on the next read', async () => {
    helpersMock.getProviderBaseDescriptor
      .mockResolvedValueOnce(descriptor('copilot', [], true))
      .mockResolvedValueOnce(descriptor('copilot', ['gpt-5']))

    const pending = await getProviderModelsCached('copilot')
    expect(pending.models).toEqual([])
    expect(pending.modelsPending).toBe(true)

    const stillPending = await getProviderModelsCached('copilot')
    expect(stillPending.modelsPending).toBe(true)

    await vi.waitFor(async () => {
      const ready = await getProviderModelsCached('copilot')
      expect(ready.models[0]?.modelId).toBe('gpt-5')
      expect(ready.modelsPending).toBeUndefined()
    })
  })

  it('treats an explicitly complete empty model list as ready', async () => {
    helpersMock.getProviderBaseDescriptor.mockResolvedValue(descriptor('custom', []))

    const first = await getProviderModelsCached('custom')
    const second = await getProviderModelsCached('custom')

    expect(first.models).toEqual([])
    expect(first.modelsPending).toBeUndefined()
    expect(second).toEqual(first)
    expect(helpersMock.getProviderBaseDescriptor).toHaveBeenCalledTimes(1)
  })
})
