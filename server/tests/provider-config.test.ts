import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTestApp, type TestApp } from './helpers/make-app.js'

describe('/api/provider-configs', () => {
  let ctx: TestApp

  beforeEach(async () => {
    ctx = await makeTestApp()
  })

  afterEach(() => {
    ctx.cleanup()
  })

  it('GET returns entries for all known providers', async () => {
    const res = await ctx.request('/api/provider-configs')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      configs: Record<string, { hasApiKey: boolean; enabled: boolean }>
    }
    // A fresh storage has no configs, so every provider should report hasApiKey=false
    for (const key of ['anthropic', 'openai', 'google']) {
      expect(body.configs[key]).toBeDefined()
      expect(body.configs[key].hasApiKey).toBe(false)
      expect(body.configs[key].enabled).toBe(false)
    }
  })

  it('PUT persists apiKey and a subsequent GET reflects it', async () => {
    const put = await ctx.request('/api/provider-configs/anthropic', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-test', enabled: true }),
    })
    expect(put.status).toBe(200)

    const get = await ctx.request('/api/provider-configs')
    const body = (await get.json()) as {
      configs: Record<string, { hasApiKey: boolean; apiKey?: string; enabled: boolean }>
    }
    expect(body.configs.anthropic.hasApiKey).toBe(true)
    expect(body.configs.anthropic.apiKey).toBe('sk-test')
    expect(body.configs.anthropic.enabled).toBe(true)
  })

  it('PUT persists manualModels (trimmed + deduped) and GET reflects them', async () => {
    const put = await ctx.request('/api/provider-configs/deepseek', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-test', manualModels: ['deepseek-chat', ' deepseek-chat ', '', 'deepseek-reasoner'] }),
    })
    expect(put.status).toBe(200)

    const get = await ctx.request('/api/provider-configs')
    const body = (await get.json()) as {
      configs: Record<string, { manualModels?: string[] }>
    }
    expect(body.configs.deepseek.manualModels).toEqual(['deepseek-chat', 'deepseek-reasoner'])
  })

  it('PUT without manualModels leaves an existing list untouched', async () => {
    await ctx.request('/api/provider-configs/deepseek', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-test', manualModels: ['deepseek-chat'] }),
    })
    // A later save that only changes enabled must not wipe manualModels
    await ctx.request('/api/provider-configs/deepseek', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })

    const get = await ctx.request('/api/provider-configs')
    const body = (await get.json()) as {
      configs: Record<string, { manualModels?: string[]; enabled: boolean }>
    }
    expect(body.configs.deepseek.manualModels).toEqual(['deepseek-chat'])
    expect(body.configs.deepseek.enabled).toBe(true)
  })

  it('GET /:providerId/models without an API key returns 400', async () => {
    const res = await ctx.request('/api/provider-configs/anthropic/models')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBeTruthy()
  })
})
