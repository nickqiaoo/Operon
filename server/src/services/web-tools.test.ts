import { expect, it, vi } from 'vitest'
import { LocalEnvironment } from 'operon-agents'
import { webToolRoutes } from '../routes/web-tools.js'
import { configuredWebTools, initWebTools } from './web-tools.js'
import type { WebToolUpdate } from '../../../shared/web-tools.js'

it('persists independent selections, reuses saved keys and runs the two DeepSeek tools', async () => {
  const values = new Map<string, unknown>()
  initWebTools({
    get: <T>(k: string) => values.get(k) as T | undefined,
    set: (k, v) => { values.set(k, v) }, delete: vi.fn(), keys: () => [], getAll: () => undefined, setAll: vi.fn(),
  })
  const routes = webToolRoutes()
  const save = (update: WebToolUpdate) => routes.request('/', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(update),
  })
  expect(configuredWebTools()).toEqual([])
  expect((await save({ search: 'deepseek', fetch: 'off', keys: {} })).status).toBe(400)
  const both = { search: 'deepseek', fetch: 'deepseek', keys: { deepseek: 'sample-key' } } as const
  expect(await (await save(both)).json()).toEqual({ search: 'deepseek', fetch: 'deepseek', configured: ['deepseek'] })
  expect(await (await routes.request('/')).text()).not.toContain('sample-key')
  const stored = await routes.request('/keys/deepseek')
  expect(stored.headers.get('cache-control')).toBe('no-store')
  expect(await stored.json()).toEqual({ key: 'sample-key' })
  expect(await (await routes.request('/keys/firecrawl')).json()).toEqual({ key: '' })
  expect((await routes.request('/keys/unknown')).status).toBe(400)
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ results: [{ url: 'https://example.com', title: 'Example', snippet: 'summary', date: null, content: '' }] }))
    .mockResolvedValueOnce(Response.json({ title: 'Example', content: 'Page body' }))
    .mockResolvedValueOnce(new Response('', { status: 401 }))
  vi.stubGlobal('fetch', request)
  try {
    const [search, read] = configuredWebTools()
    expect([search.schema.name, read.schema.name]).toEqual(['WebSearch', 'WebFetch'])
    const ctx = { environment: new LocalEnvironment(process.cwd()), signal: new AbortController().signal, turnId: 't', toolCallId: 'tc', suspend: (): never => { throw new Error('unexpected suspension') } }
    for (const [tool, args, endpoint, payload, output] of [
      [search, { query: 'example' }, 'search', { query: 'example', count: 5, need_content: false }, 'summary'],
      [read, { url: 'https://example.com' }, 'fetch', { url: 'https://example.com' }, 'Page body'],
    ] as const) {
      const result = await (await tool.resolve(args, ctx)).run(ctx)
      expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining(output) })])
      expect(request).toHaveBeenLastCalledWith(`https://api.deepseek.com/v1/tools/${endpoint}`, expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer sample-key' }), body: JSON.stringify(payload), signal: ctx.signal,
      }))
    }
    const failure = await (await search.resolve({ query: 'test' }, ctx)).run(ctx)
    expect(failure.isError).toBe(true)
    expect(await (await save({ search: 'tavily', fetch: 'deepseek', keys: { tavily: 'other' } })).json())
      .toEqual({ search: 'tavily', fetch: 'deepseek', configured: ['deepseek', 'tavily'] })
    for (const searchProvider of ['deepseek', 'firecrawl', 'tavily'] as const) {
      for (const fetchProvider of ['deepseek', 'firecrawl', 'tavily'] as const) {
        const response = await save({ search: searchProvider, fetch: fetchProvider, keys: { firecrawl: 'fixture' } })
        expect(response.status).toBe(200)
        const [searchTool, fetchTool] = configuredWebTools()
        const searchPaths = { deepseek: '/v1/tools/search', firecrawl: '/v1/search', tavily: '/search' }
        const fetchPaths = { deepseek: '/v1/tools/fetch', firecrawl: '/v1/scrape', tavily: '/extract' }
        request.mockResolvedValueOnce(Response.json({ results: [], data: [] }))
        const searchResult = await (await searchTool.resolve({ query: 'example' }, ctx)).run(ctx)
        expect(searchResult.isError).toBeFalsy()
        expect(new URL(String(request.mock.lastCall?.[0])).pathname).toBe(searchPaths[searchProvider])
        request.mockResolvedValueOnce(Response.json({
          title: 'Page', content: 'body', data: { markdown: 'body' },
          results: [{ url: 'https://example.com', raw_content: 'body' }],
        }))
        const page = await (await fetchTool.resolve({ url: 'https://example.com' }, ctx)).run(ctx)
        expect(page.isError).toBeFalsy()
        expect(new URL(String(request.mock.lastCall?.[0])).pathname).toBe(fetchPaths[fetchProvider])
      }
    }
    expect((await save({ search: 'off', fetch: 'direct', keys: {} })).status).toBe(200)
    expect(configuredWebTools().map(tool => tool.schema.name)).toEqual(['WebFetch'])
  } finally {
    vi.unstubAllGlobals()
  }
})
