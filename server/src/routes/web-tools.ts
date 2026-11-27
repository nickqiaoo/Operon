import { Hono } from 'hono'
import { z } from 'zod'
import { searchProviders, fetchProviders, keyedProviders } from '../../../shared/web-tools.js'
import { getWebToolKey, getWebToolSettings, saveWebToolSettings, MissingWebToolKeyError } from '../services/web-tools.js'

const input = z.object({
  search: z.enum(searchProviders),
  fetch: z.enum(fetchProviders),
  keys: z.object({ deepseek: z.string().trim().optional(), firecrawl: z.string().trim().optional(), tavily: z.string().trim().optional() }).strict(),
})

export function webToolRoutes() {
  return new Hono()
    .get('/', c => c.json(getWebToolSettings()))
    .get('/keys/:provider', c => {
      const provider = z.enum(keyedProviders).safeParse(c.req.param('provider'))
      if (!provider.success) return c.json({ error: 'Unknown provider.' }, 400)
      c.header('Cache-Control', 'no-store')
      return c.json({ key: getWebToolKey(provider.data) })
    })
    .put('/', async c => {
      const parsed = input.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return c.json({ error: 'Invalid web tool settings.' }, 400)
      try {
        return c.json(saveWebToolSettings(parsed.data))
      } catch (error) {
        if (error instanceof MissingWebToolKeyError) return c.json({ error: error.message }, 400)
        throw error
      }
    })
}
