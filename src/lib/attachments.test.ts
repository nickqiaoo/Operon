import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { persistBlobUrl, preuploadBlobUrl } from './attachments'

vi.mock('./api-client', () => ({
  apiAuthHeaders: () => ({}),
  getBaseUrl: async () => 'http://server/api',
  getBaseUrlSync: () => 'http://server/api',
  withApiTokenQuery: (url: string) => url,
}))

const STORED = { hash: 'a', url: '/api/attachments/a', mediaType: 'image/png', sizeBytes: 1 }

describe('preuploadBlobUrl', () => {
  let uploads: Array<() => Response>

  beforeEach(() => {
    uploads = []
    vi.stubGlobal('fetch', vi.fn(async (_input: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return new Response(new Blob(['x']))
      const respond = uploads.shift()
      return respond ? respond() : Response.json(STORED)
    }))
  })

  afterEach(() => vi.unstubAllGlobals())

  const postCount = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST').length

  it('uploads once, and the send reuses that upload', async () => {
    preuploadBlobUrl('blob:once')
    preuploadBlobUrl('blob:once')
    await expect(persistBlobUrl('blob:once')).resolves.toBe(STORED.url)
    await expect(persistBlobUrl('blob:once')).resolves.toBe(STORED.url)
    expect(postCount()).toBe(1)
  })

  it('tries again at send when the early upload failed', async () => {
    uploads.push(() => new Response('nope', { status: 500 }))
    preuploadBlobUrl('blob:retry')
    await vi.waitFor(() => expect(postCount()).toBe(1))
    await new Promise((resolve) => setTimeout(resolve))
    await expect(persistBlobUrl('blob:retry')).resolves.toBe(STORED.url)
    expect(postCount()).toBe(2)
  })
})
