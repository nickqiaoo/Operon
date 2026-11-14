import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiKeyCatalogProviders, piCatalog } from './pi-catalog.js'
import { fetchProviderModels, PROVIDER_META } from './provider-config.js'

afterEach(() => vi.unstubAllGlobals())

describe('Pi provider catalog', () => {
  it('exposes key-based providers with models and keeps special setup out of the form', () => {
    const providers = apiKeyCatalogProviders()
    const ids = providers.map((provider) => provider.id)
    expect(ids).toEqual(expect.arrayContaining([
      'qwen-token-plan', 'qwen-token-plan-cn', 'qwen-token-plan-individual', 'qwen-token-plan-individual-cn',
    ]))
    for (const id of ['azure', 'amazon-bedrock', 'google-vertex', 'cloudflare-workers-ai', 'cloudflare-ai-gateway', 'openai-codex']) {
      expect(ids).not.toContain(id)
    }
    for (const provider of providers) {
      expect(provider.auth.apiKey).toBeDefined()
      expect(piCatalog.getModels(provider.id).length).toBeGreaterThan(0)
      expect(PROVIDER_META[provider.id]).toBeDefined()
    }
  })

  it('uses only Pi IDs without legacy duplicates', () => {
    expect(Object.keys(PROVIDER_META)).toEqual(apiKeyCatalogProviders().map((provider) => provider.id))
    expect(PROVIDER_META['vercel-ai-gateway']).toBeDefined()
    for (const id of ['vercel', 'grok', 'kimi', 'glm', 'ollama']) expect(PROVIDER_META[id]).toBeUndefined()
  })

  it('lists plan models without requiring a live /models endpoint', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('No /models endpoint'))
    vi.stubGlobal('fetch', fetch)
    const models = await fetchProviderModels('qwen-token-plan-cn', { apiKey: 'test-key' })
    expect(models).toContainEqual({ id: 'qwen3.8-max', name: 'Qwen3.8 Max' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses the overridden endpoint for both Qwen plans, just like a custom provider', async () => {
    const baseUrl = 'https://proxy.example.com/compatible-mode/v1/'
    const fetch = vi.fn().mockImplementation(async () => Response.json({ data: [{ id: 'endpoint-only-model' }] }))
    vi.stubGlobal('fetch', fetch)
    const config = { apiKey: 'test-key', baseUrl }
    const expected = [{ id: 'endpoint-only-model', name: 'endpoint-only-model' }]
    expect(await fetchProviderModels('qwen-token-plan', config)).toEqual(expected)
    expect(await fetchProviderModels('qwen-token-plan-individual', config)).toEqual(expected)
    expect(await fetchProviderModels('custom-qwen', {
      ...config, custom: { name: 'Qwen', api: 'openai-completions' },
    })).toEqual(expected)
    expect(fetch).toHaveBeenCalledTimes(3)
    for (const args of fetch.mock.calls) {
      expect(args).toEqual([
        'https://proxy.example.com/compatible-mode/v1/models',
        { headers: { Authorization: 'Bearer test-key' } },
      ])
    }
  })

  it.each([
    ['openai', 'https://proxy.example.com', 'https://proxy.example.com/v1/models'],
    ['openai', 'https://proxy.example.com/v1/', 'https://proxy.example.com/v1/models'],
    ['anthropic', 'https://proxy.example.com/anthropic/v1/', 'https://proxy.example.com/anthropic/v1/models'],
  ])('lists %s models at the overridden URL %s', async (providerId, baseUrl, expectedUrl) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: [{ id: 'new-model', display_name: 'New Model' }] }))
    vi.stubGlobal('fetch', fetch)
    const models = await fetchProviderModels(providerId, { apiKey: 'k', baseUrl })
    expect(models.map((model) => model.id)).toEqual(['new-model'])
    expect(fetch.mock.calls[0]?.[0]).toBe(expectedUrl)
    if (providerId === 'anthropic') {
      expect(fetch.mock.calls[0]?.[1]).toEqual({ headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' } })
    }
  })

  it('uses the Google protocol at an overridden endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ models: [
      { name: 'models/gemini-new', displayName: 'Gemini New', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
    ] }))
    vi.stubGlobal('fetch', fetch)
    expect(await fetchProviderModels('google', { apiKey: 'k', baseUrl: 'https://proxy.example.com/v1beta/' }))
      .toEqual([{ id: 'gemini-new', name: 'Gemini New' }])
    expect(fetch).toHaveBeenCalledWith('https://proxy.example.com/v1beta/models?key=k')
  })

  it('reports override errors rather than substituting the built-in catalog', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('Invalid key', { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    await expect(fetchProviderModels('qwen-token-plan', { apiKey: 'k', baseUrl: 'https://proxy.example.com/v1' }))
      .rejects.toThrow('401')
  })

  it('keeps Mistral chat cards and excludes non-chat models at an overridden endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: [
      { id: 'chat-model', type: 'base', capabilities: { completion_chat: true, function_calling: true } },
      { id: 'embedding', type: 'base', capabilities: { completion_chat: false } },
      { id: 'image', type: 'image' },
    ] }))
    vi.stubGlobal('fetch', fetch)
    expect(await fetchProviderModels('mistral', { apiKey: 'k', baseUrl: 'https://proxy.example.com' }))
      .toEqual([{ id: 'chat-model', name: 'chat-model' }])
    expect(fetch.mock.calls[0]?.[0]).toBe('https://proxy.example.com/v1/models')
  })
})
