import { beforeEach, describe, expect, it, vi } from 'vitest'

const invalidateProviderModels = vi.fn()

vi.mock('../services/ai.js', () => ({ invalidateProviderModels }))
vi.mock('../services/provider-config.js', () => ({
  getProviderConfigs: () => ({}),
  getProviderConfig: () => ({}),
  setProviderConfig: vi.fn(),
  deleteProviderConfig: vi.fn(),
  fetchProviderModels: vi.fn(),
  normalizeManualModels: (models: string[]) => models,
  PROVIDER_META: {},
}))

const { providerConfigRoutes } = await import('./provider-config.js')

describe('provider config routes', () => {
  beforeEach(() => invalidateProviderModels.mockClear())

  it("refreshes Operon's catalog as well when a provider is switched on", async () => {
    const res = await providerConfigRoutes().request('/mistral', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(res.status).toBe(200)
    expect(invalidateProviderModels.mock.calls.map(([id]) => id)).toEqual(['mistral', 'custom'])
  })

  it("refreshes Operon's catalog as well when a user-added provider is removed", async () => {
    const res = await providerConfigRoutes().request('/custom-endpoint', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(invalidateProviderModels.mock.calls.map(([id]) => id)).toEqual(['custom-endpoint', 'custom'])
  })
})
