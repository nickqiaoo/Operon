import { Hono } from 'hono'
import { hostname } from 'node:os'
import { saasStatus, saasLogin, saasLogout } from '../gateway/saas/index.js'
import type { SaasAuthProvider } from '../gateway/saas/oauth-flow.js'
import { normalizeSaasLoginError } from '../gateway/saas/errors.js'

// Desktop-side SaaS connection: login to the broker, register this machine as a
// node, and persist the node token for the tunnel agent. The renderer's SaaS
// settings page drives these.
export function saasRoutes() {
  const router = new Hono()

  router.get('/status', (c) => c.json(saasStatus()))

  router.post('/login', async (c) => {
    // No brokerUrl in the body: which broker this build talks to is not the
    // renderer's to decide (see gateway/saas/broker.ts).
    const body = await c.req.json<{ provider?: string; label?: string }>()
    // Anything unrecognized falls back to GitHub rather than reaching the broker
    // as an "unknown provider" 400.
    const provider: SaasAuthProvider = body.provider === 'apple' ? 'apple' : 'github'
    try {
      const result = await saasLogin(provider, body.label?.trim() || hostname())
      return c.json(result)
    } catch (err) {
      const loginError = normalizeSaasLoginError(err)
      return c.json({ error: loginError.message, code: loginError.code, message: loginError.message }, 500)
    }
  })

  router.post('/logout', async (c) => {
    await saasLogout()
    return c.json({ success: true })
  })

  return router
}
