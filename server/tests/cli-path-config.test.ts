import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTestApp, type TestApp } from './helpers/make-app.js'

describe('/api/cli-paths', () => {
  let ctx: TestApp

  beforeEach(async () => {
    ctx = await makeTestApp()
  })

  afterEach(() => {
    ctx.cleanup()
  })

  it('GET returns info for every known adapter', async () => {
    const res = await ctx.request('/api/cli-paths')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    for (const id of ['claude-code', 'codex', 'opencode', 'kimi']) {
      expect(body[id]).toBeDefined()
    }
  })

  it('PUT on a valid adapter id responds with info', async () => {
    const res = await ctx.request('/api/cli-paths/claude-code', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/usr/local/bin/claude' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; info: unknown }
    expect(body.success).toBe(true)
    expect(body.info).toBeDefined()
  })

  it('PUT on an invalid adapter id returns 400', async () => {
    const res = await ctx.request('/api/cli-paths/not-a-thing', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/usr/local/bin/x' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/Invalid/)
  })
})
