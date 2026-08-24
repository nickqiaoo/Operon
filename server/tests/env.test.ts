import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTestApp, type TestApp } from './helpers/make-app.js'

describe('/api/env', () => {
  let ctx: TestApp

  beforeEach(async () => {
    ctx = await makeTestApp()
  })

  afterEach(() => {
    ctx.cleanup()
    delete process.env.OPERON_TEST_ENV_KEY
  })

  it('GET returns empty vars on a fresh storage', async () => {
    const res = await ctx.request('/api/env')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { vars: Record<string, string> }
    expect(body.vars).toEqual({})
  })

  it('PUT persists env vars and applies them to process.env', async () => {
    const put = await ctx.request('/api/env', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vars: { OPERON_TEST_ENV_KEY: 'hello' } }),
    })
    expect(put.status).toBe(200)
    expect(process.env.OPERON_TEST_ENV_KEY).toBe('hello')

    const get = await ctx.request('/api/env')
    const body = (await get.json()) as { vars: Record<string, string> }
    expect(body.vars).toEqual({ OPERON_TEST_ENV_KEY: 'hello' })
  })

  it('PUT with malformed JSON body fails', async () => {
    const res = await ctx.request('/api/env', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    // Hono's onError returns 500 for unhandled errors
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})
