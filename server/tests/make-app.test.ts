import { describe, it, expect, afterEach } from 'vitest'
import { makeTestApp, type TestApp } from './helpers/make-app.js'

describe('makeTestApp', () => {
  let ctx: TestApp | null = null

  afterEach(() => {
    ctx?.cleanup()
    ctx = null
  })

  it('serves /api/health', async () => {
    ctx = await makeTestApp()
    const res = await ctx.request('/api/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('ok')
  })
})
