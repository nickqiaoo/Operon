import { afterAll, describe, expect, it, vi } from 'vitest'
import { installRefreshSingleFlight, refreshKey } from './oauth-refresh-single-flight.js'

const realFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = realFetch
})

const refresh = (token: string): RequestInit => ({
  method: 'POST',
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: 'c' }),
})

describe('refreshKey', () => {
  it('keys only refresh-token grants', () => {
    expect(refreshKey('https://a/token', refresh('r1'))).toBe('https://a/token r1')
    expect(refreshKey('https://a/token', { method: 'POST', body: 'grant_type=refresh_token&refresh_token=r2' })).toBe('https://a/token r2')
    expect(refreshKey('https://a/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code' }) })).toBeUndefined()
    expect(refreshKey('https://a/mcp', { method: 'GET' })).toBeUndefined()
  })
})

describe('installRefreshSingleFlight', () => {
  it('sends one refresh for concurrent and late callers with the same token, passes the rest through', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls++
      await new Promise((resolve) => setTimeout(resolve, 10))
      return new Response(JSON.stringify({ access_token: `a${calls}`, refresh_token: `r${calls + 1}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    installRefreshSingleFlight()

    const [x, y] = await Promise.all([fetch('https://a/token', refresh('r1')), fetch('https://a/token', refresh('r1'))])
    const late = await fetch('https://a/token', refresh('r1'))
    expect(calls).toBe(1)
    for (const response of [x, y, late]) expect(await response.json()).toEqual({ access_token: 'a1', refresh_token: 'r2' })

    await fetch('https://a/token', refresh('r2'))
    await fetch('https://a/mcp', { method: 'POST', body: '{}' })
    expect(calls).toBe(3)
  })
})
