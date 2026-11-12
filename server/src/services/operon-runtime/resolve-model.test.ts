import { beforeEach, describe, expect, it, vi } from 'vitest'

const CUSTOM: Record<string, object> = {
  'custom-chat': { baseUrl: 'https://llm.example.com', custom: { name: 'Chat', api: 'openai-completions' } },
  'custom-responses': { apiKey: 'k', baseUrl: 'https://llm.example.com/v1', custom: { name: 'Responses', api: 'openai-responses' } },
  'custom-messages': { apiKey: 'k', baseUrl: 'https://llm.example.com/anthropic/v1', custom: { name: 'Messages', api: 'anthropic-messages' } },
  mistral: { apiKey: 'mistral-key', baseUrl: 'https://api.mistral.ai/v1/' },
}

let configured: Record<string, object> = {}

vi.mock('../provider-config.js', () => ({
  getProviderConfig: (id: string) => CUSTOM[id] ?? { apiKey: 'test-key' },
  getProviderConfigs: () => ({ ...CUSTOM, ...configured }),
  isProviderUsable: () => true,
}))

const { DecisionModel, ChatModel } = await import('operon-agents/advanced')
const { getModelCapabilities, listDecisionModels, modelRef, resolveModel, resolveReviewModel, syncModelProvider, syncModelProviders } = await import('./resolve-model.js')

beforeEach(() => {
  configured = {}
  syncModelProviders()
})

describe('decision models', () => {
  it('lists only what an enabled provider can run on its own service', () => {
    configured = { vercel: { enabled: true, apiKey: 'k' }, openrouter: { enabled: false, apiKey: 'k' } }
    const ids = listDecisionModels().map((m) => m.modelId)
    expect(ids).toContain('vercel/microsoft/microsoft-decision-1')
    expect(ids.every((id) => id.startsWith('vercel/'))).toBe(true)
  })

  it('offers none behind a custom base URL, whose key must not reach the catalog endpoints', () => {
    configured = { vercel: { enabled: true, apiKey: 'k', baseUrl: 'https://proxy.example.com/v1' } }
    expect(listDecisionModels()).toEqual([])
  })

  it('resolves a pick to the kind of model it names', async () => {
    expect(await resolveReviewModel('vercel/microsoft/microsoft-decision-1')).toBeInstanceOf(DecisionModel)
    expect(await resolveReviewModel('vercel/deepseek/deepseek-v4-flash')).toBeInstanceOf(ChatModel)
  })

  it('returns the same model until its provider config changes', async () => {
    const id = 'vercel/microsoft/microsoft-decision-1'
    const first = await resolveReviewModel(id)
    expect(await resolveReviewModel(id)).toBe(first)
    CUSTOM.vercel = { apiKey: 'rotated-key' }
    try {
      expect(await resolveReviewModel(id)).not.toBe(first)
    } finally {
      delete CUSTOM.vercel
    }
  })
})

describe('provider sync', () => {
  const authOf = async (modelId: string) => {
    let auth: string | null | undefined
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      auth = new Request(input, init).headers.get('authorization')
      return new Response('{"error":{"message":"stub"}}', { status: 400, headers: { 'content-type': 'application/json' } })
    })
    try {
      await resolveModel(modelId).complete({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 }] })
      return auth
    } finally {
      vi.unstubAllGlobals()
    }
  }

  it('uses a changed key as soon as the provider is synced', async () => {
    expect(await authOf('custom-responses/gpt-6')).toBe('Bearer k')
    const saved = CUSTOM['custom-responses']
    CUSTOM['custom-responses'] = { ...saved, apiKey: 'rotated' }
    try {
      syncModelProvider('custom-responses')
      expect(await authOf('custom-responses/gpt-6')).toBe('Bearer rotated')
    } finally {
      CUSTOM['custom-responses'] = saved!
    }
  })

  it('removes a user-added provider once its config is gone', () => {
    const saved = CUSTOM['custom-chat']
    expect(resolveModel('custom-chat/m').id).toBe('m')
    delete CUSTOM['custom-chat']
    try {
      syncModelProvider('custom-chat')
      expect(() => resolveModel('custom-chat/m')).toThrow(/unknown model/)
    } finally {
      CUSTOM['custom-chat'] = saved!
    }
  })

  it('reads a bare model id as Anthropic', () => {
    expect(modelRef('claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6')
    expect(modelRef('vercel/zai/glm-5')).toBe('vercel/zai/glm-5')
  })
})

describe('getModelCapabilities', () => {
  it('offers only the thinking levels the catalog does not mark as unsupported', () => {
    expect(getModelCapabilities('mistral/mistral-large-4').effortLevels).toEqual(['low', 'medium', 'high'])
    expect(getModelCapabilities('mistral/zai-glm-5-3').effortLevels).toEqual(['low', 'high'])
  })

  it('offers no levels for a model without thinking', () => {
    expect(getModelCapabilities('mistral/codestral-latest').effortLevels).toEqual([])
  })
})

describe('resolveModel on Mistral', () => {
  const firstRequest = async (modelId: string) => {
    const seen: Request[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Request(input, init))
      return new Response('{"error":{"message":"stub"}}', { status: 400, headers: { 'content-type': 'application/json' } })
    })
    try {
      const model = await resolveModel(modelId)
      await model.complete({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 }] })
      return { api: model.api, url: seen[0]?.url, auth: seen[0]?.headers.get('authorization') }
    } finally {
      vi.unstubAllGlobals()
    }
  }
  const expected = { api: 'mistral-conversations', url: 'https://api.mistral.ai/v1/chat/completions', auth: 'Bearer mistral-key' }

  it('sends a catalog model through the Mistral dialect, with the saved key', async () => {
    expect(await firstRequest('mistral/mistral-large-latest')).toEqual(expected)
  })

  it('sends a model newer than the catalog the same way', async () => {
    expect(await firstRequest('mistral/mistral-not-in-the-catalog')).toEqual(expected)
  })

  const sentEffort = async (thinking?: 'high') => {
    let body = ''
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      body = await new Request(input, init).text()
      return new Response('{"error":{"message":"stub"}}', { status: 400, headers: { 'content-type': 'application/json' } })
    })
    try {
      const model = await resolveModel('mistral/mistral-large-4')
      await model.complete({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 }],
        ...(thinking ? { params: { reasoning: thinking } } : {}),
      })
      return (JSON.parse(body) as { reasoning_effort?: string }).reasoning_effort
    } finally {
      vi.unstubAllGlobals()
    }
  }

  it('leaves reasoning_effort out when no effort was chosen, since mistral-large-4 rejects "none"', async () => {
    expect(await sentEffort()).toBeUndefined()
  })

  it('still sends the effort the user chose', async () => {
    expect(await sentEffort('high')).toBe('high')
  })
})

describe('resolveModel on a gateway', () => {
  it('sends Claude on Vercel AI Gateway through its Anthropic Messages endpoint', async () => {
    const model = await resolveModel('vercel/anthropic/claude-haiku-4.5')
    expect(model.provider).toBe('vercel-ai-gateway')
    expect(model.api).toBe('anthropic-messages')
    expect(model.id).toBe('anthropic/claude-haiku-4.5')
  })

  it('runs other Vercel models the way pi catalogs them, with its limits', async () => {
    const model = await resolveModel('vercel/zai/glm-5')
    expect(model.provider).toBe('vercel-ai-gateway')
    expect(model.api).toBe('anthropic-messages')
    // From pi's vercel-ai-gateway catalog, not the 200K fallback.
    expect(model.contextWindow).toBe(202_800)
  })

  it('falls back to the defaults for a Vercel model pi does not know yet', async () => {
    const model = await resolveModel('vercel/openai/not-in-the-catalog')
    expect(model.api).toBe('anthropic-messages')
    expect(model.contextWindow).toBe(200_000)
  })

  it('runs a custom provider on the API it was set up with, at the normalized base URL', async () => {
    // Where the request actually goes: the first URL handed to fetch.
    const urlOf = async (modelId: string) => {
      const seen: string[] = []
      vi.stubGlobal('fetch', async (input: string | URL | Request) => {
        seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        return new Response('{"error":{"message":"stub"}}', { status: 400, headers: { 'content-type': 'application/json' } })
      })
      try {
        const model = await resolveModel(modelId)
        await model.complete({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 }] })
        return { api: model.api, id: model.id, url: seen[0] }
      } finally {
        vi.unstubAllGlobals()
      }
    }
    expect(await urlOf('custom-chat/meta/llama-4')).toEqual({ api: 'openai-completions', id: 'meta/llama-4', url: 'https://llm.example.com/v1/chat/completions' })
    expect(await urlOf('custom-responses/gpt-6')).toMatchObject({ api: 'openai-responses', url: 'https://llm.example.com/v1/responses' })
    expect(await urlOf('custom-messages/glm-5')).toMatchObject({ api: 'anthropic-messages', url: expect.stringMatching(/^https:\/\/llm\.example\.com\/anthropic\/v1\/messages(\?|$)/) })
    expect((await resolveModel('custom-messages/glm-5')).contextWindow).toBe(200_000)
  })

  it('leaves OpenRouter routing to pi\'s catalog', async () => {
    const claude = await resolveModel('openrouter/anthropic/claude-sonnet-4.5')
    expect(claude.provider).toBe('openrouter')
    expect(claude.api).toBe('anthropic-messages')
    const glm = await resolveModel('openrouter/z-ai/glm-4.6')
    expect(glm.provider).toBe('openrouter')
    expect(glm.api).toBe('openai-completions')
  })
})
