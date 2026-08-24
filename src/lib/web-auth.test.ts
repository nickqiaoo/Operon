import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// web-auth talks to browser globals but only from inside its functions, so a few
// hand-rolled stubs are enough (the repo's vitest environment is `node`).

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
}

interface LocationStub {
  origin: string
  pathname: string
  search: string
  href: string
}

interface Stubs {
  local: MemoryStorage
  session: MemoryStorage
  location: LocationStub
  replaceState: ReturnType<typeof vi.fn>
}

let stubs: Stubs

function installBrowserStubs(): Stubs {
  const local = new MemoryStorage()
  const session = new MemoryStorage()
  const location: LocationStub = {
    origin: 'https://app.operon.teslawrap.top',
    pathname: '/',
    search: '',
    href: 'https://app.operon.teslawrap.top/',
  }
  const replaceState = vi.fn()

  vi.stubGlobal('localStorage', local)
  vi.stubGlobal('sessionStorage', session)
  vi.stubGlobal('window', {
    location,
    history: { replaceState },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })

  return { local, session, location, replaceState }
}

async function importWebAuth() {
  return import('./web-auth')
}

beforeEach(() => {
  vi.resetModules()
  stubs = installBrowserStubs()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('PKCE verifier storage', () => {
  it('survives the sessionStorage wipe an installed PWA takes across the OAuth round-trip', async () => {
    const { login, handleCallback } = await importWebAuth()

    await login('github')
    const verifier = stubs.local.getItem('operon.web.pkce')
    expect(verifier).toBeTruthy()

    // iOS hands the cross-origin authorize URL to Safari and reloads the PWA
    // from start_url when the callback returns — sessionStorage does not survive
    // that, which is exactly what used to break sign-in.
    stubs.session.clear()
    stubs.location.pathname = '/auth/callback'
    stubs.location.search = '?code=one-time-code'

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access: 'signed.jwt.token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await handleCallback()

    expect(result).toEqual({ ok: true })
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      code: string
      code_verifier: string
    }
    expect(body.code).toBe('one-time-code')
    expect(body.code_verifier).toBe(verifier)
    expect(stubs.local.getItem('operon.web.access')).toBe('signed.jwt.token')
  })

  it('is single-use — cleared once the code is exchanged', async () => {
    const { login, handleCallback } = await importWebAuth()

    await login('github')
    stubs.location.pathname = '/auth/callback'
    stubs.location.search = '?code=one-time-code'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ access: 'tok' }), { status: 200 }))
    )

    await handleCallback()

    expect(stubs.local.getItem('operon.web.pkce')).toBeNull()
    expect(stubs.session.getItem('operon.web.pkce')).toBeNull()
  })
})

describe('handleCallback', () => {
  beforeEach(() => {
    stubs.location.pathname = '/auth/callback'
  })

  it('explains an expired sign-in instead of bouncing silently to the login page', async () => {
    const { handleCallback } = await importWebAuth()
    stubs.location.search = '?code=stale-code'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'invalid or expired code' }), { status: 400 }))
    )

    const result = await handleCallback()

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/expired/i)
  })

  it('surfaces the broker error when GitHub itself failed', async () => {
    const { handleCallback } = await importWebAuth()
    stubs.location.search = '?error=github_timeout&message=GitHub%20took%20too%20long'

    const result = await handleCallback()

    expect(result).toEqual({ ok: false, reason: 'GitHub took too long' })
  })

  it('always clears the callback URL so a reload cannot replay a consumed code', async () => {
    const { handleCallback } = await importWebAuth()
    stubs.location.search = '?code=stale-code'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 400 })))

    await handleCallback()

    expect(stubs.replaceState).toHaveBeenCalledWith({}, '', '/')
  })

  it('reports an unreachable broker rather than failing as a bad login', async () => {
    const { handleCallback } = await importWebAuth()
    stubs.location.search = '?code=some-code'
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network request failed')))

    const result = await handleCallback()

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/connection/i)
  })
})
