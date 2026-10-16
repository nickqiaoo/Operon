import { describe, expect, it, vi } from 'vitest'

const CUSTOM: Record<string, object> = {
  'custom-chat': { baseUrl: 'https://llm.example.com', custom: { name: 'Chat', api: 'openai-completions' } },
  'custom-responses': { apiKey: 'k', baseUrl: 'https://llm.example.com/v1', custom: { name: 'Responses', api: 'openai-responses' } },
  'custom-messages': { apiKey: 'k', baseUrl: 'https://llm.example.com/anthropic/v1', custom: { name: 'Messages', api: 'anthropic-messages' } },
}

vi.mock('../provider-config.js', () => ({ getProviderConfig: (id: string) => CUSTOM[id] ?? { apiKey: 'test-key' } }))

const { resolveModel } = await import('./resolve-model.js')

describe('resolveModel on a gateway', () => {
  it('sends Claude on Vercel AI Gateway through its Anthropic Messages endpoint', async () => {
    const model = await resolveModel('vercel/anthropic/claude-haiku-4.5')
    expect(model.provider).toBe('vercel-anthropic')
    expect(model.api).toBe('anthropic-messages')
    expect(model.id).toBe('anthropic/claude-haiku-4.5')
  })

  it('keeps other Vercel models on Chat Completions, with the limits of pi\'s catalog', async () => {
    const model = await resolveModel('vercel/zai/glm-5')
    expect(model.provider).toBe('vercel')
    expect(model.api).toBe('openai-completions')
    // From pi's vercel-ai-gateway catalog, not the 200K fallback.
    expect(model.contextWindow).toBe(202_800)
  })

  it('falls back to the defaults for a Vercel model pi does not know yet', async () => {
    const model = await resolveModel('vercel/openai/not-in-the-catalog')
    expect(model.api).toBe('openai-completions')
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

  it('leaves OpenRouter as it was', async () => {
    expect((await resolveModel('openrouter/anthropic/claude-sonnet-4.5')).provider).toBe('openrouter-anthropic')
    const glm = await resolveModel('openrouter/z-ai/glm-4.6')
    expect(glm.provider).toBe('openrouter')
    expect(glm.api).toBe('openai-completions')
  })
})
