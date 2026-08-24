import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createApiTokenMiddleware, getApiToken } from './api-token.js'

// The middleware self-disables under NODE_ENV=test so route tests don't have
// to authenticate; these tests flip NODE_ENV to exercise the enabled path.
const savedNodeEnv = process.env.NODE_ENV
const savedDisable = process.env.OPERON_DISABLE_API_TOKEN

function buildApp(): Hono {
  const app = new Hono()
  app.use('/api/*', createApiTokenMiddleware())
  app.get('/api/health', (c) => c.json({ status: 'ok' }))
  app.get('/api/secret', (c) => c.json({ data: 42 }))
  return app
}

describe('createApiTokenMiddleware', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production'
    delete process.env.OPERON_DISABLE_API_TOKEN
  })

  afterEach(() => {
    process.env.NODE_ENV = savedNodeEnv
    if (savedDisable === undefined) delete process.env.OPERON_DISABLE_API_TOKEN
    else process.env.OPERON_DISABLE_API_TOKEN = savedDisable
  })

  it('rejects a request without a token', async () => {
    const res = await buildApp().request('/api/secret')
    expect(res.status).toBe(401)
  })

  it('rejects a wrong token', async () => {
    const res = await buildApp().request('/api/secret', {
      headers: { 'x-operon-token': 'nope' },
    })
    expect(res.status).toBe(401)
  })

  it('accepts the token via x-operon-token header', async () => {
    const res = await buildApp().request('/api/secret', {
      headers: { 'x-operon-token': getApiToken() },
    })
    expect(res.status).toBe(200)
  })

  it('accepts the token via Authorization bearer', async () => {
    const res = await buildApp().request('/api/secret', {
      headers: { authorization: `Bearer ${getApiToken()}` },
    })
    expect(res.status).toBe(200)
  })

  it('accepts the token via query param', async () => {
    const res = await buildApp().request(`/api/secret?token=${getApiToken()}`)
    expect(res.status).toBe(200)
  })

  it('does not let an unrelated bearer veto a valid token header', async () => {
    // Web-client traffic arrives with its broker Authorization header AND the
    // tunnel-injected token; the mismatched bearer must not cause a 401.
    const res = await buildApp().request('/api/secret', {
      headers: {
        authorization: 'Bearer some-broker-access-token',
        'x-operon-token': getApiToken(),
      },
    })
    expect(res.status).toBe(200)
  })

  it('exempts /api/health', async () => {
    const res = await buildApp().request('/api/health')
    expect(res.status).toBe(200)
  })

  it('passes everything through when disabled', async () => {
    process.env.OPERON_DISABLE_API_TOKEN = '1'
    const res = await buildApp().request('/api/secret')
    expect(res.status).toBe(200)
  })
})
