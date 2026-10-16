import { describe, expect, it } from 'vitest'
import { customProviderBaseUrl, customProviderId, isCustomProviderId } from './provider-config'

describe('customProviderId', () => {
  it('slugs the name into a custom- id', () => {
    expect(customProviderId('Deep Infra!', new Set())).toBe('custom-deep-infra')
  })

  it('numbers an id that is taken', () => {
    expect(customProviderId('Local', new Set(['custom-local', 'custom-local-2']))).toBe('custom-local-3')
  })

  it('falls back when the name has no ASCII letters or digits', () => {
    expect(customProviderId('本地模型', new Set())).toBe('custom-provider')
  })

  it('is recognised as custom, and the bare prefix is not', () => {
    expect(isCustomProviderId(customProviderId('x', new Set()))).toBe(true)
    expect(isCustomProviderId('custom-')).toBe(false)
    expect(isCustomProviderId('openrouter')).toBe(false)
  })
})

describe('customProviderBaseUrl', () => {
  it('gives a bare host the usual /v1 for the OpenAI APIs', () => {
    expect(customProviderBaseUrl('openai-completions', 'https://api.example.com/')).toBe('https://api.example.com/v1')
    expect(customProviderBaseUrl('openai-responses', 'https://api.example.com')).toBe('https://api.example.com/v1')
  })

  it('keeps a path the provider documents', () => {
    expect(customProviderBaseUrl('openai-completions', 'https://open.bigmodel.cn/api/paas/v4/')).toBe('https://open.bigmodel.cn/api/paas/v4')
  })

  it('drops a trailing /v1 for Anthropic, whose client adds /v1/messages', () => {
    expect(customProviderBaseUrl('anthropic-messages', 'https://api.example.com/anthropic/v1/')).toBe('https://api.example.com/anthropic')
    expect(customProviderBaseUrl('anthropic-messages', 'https://api.example.com')).toBe('https://api.example.com')
  })
})
