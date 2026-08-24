import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MiddlewareHandler } from 'hono'

/**
 * Startup token that gates every /api/* request.
 *
 * The server binds 127.0.0.1, but loopback alone is not an auth boundary: any
 * local process — and, because of CORS, any web page the user visits — can
 * reach the port. The token turns "can send a TCP packet to localhost" into
 * "was handed the secret by a trusted channel":
 *
 *  - Electron renderer: over IPC (`server:get-token`), never written to disk.
 *  - Embedded tunnel agent (saas-runtime): passed in-process via `getApiToken()`.
 *  - Standalone tunnel agent / Chrome-extension native host: read from
 *    `~/.operon/run/api-token` (0600 inside the 0700 run dir).
 *  - Spawned agent CLIs: baked into their per-session MCP URLs as a `token`
 *    query param (headers are dropped by some MCP clients, see mcp-config.ts).
 *
 * This deliberately does NOT defend against a malicious process running as the
 * same OS user — that attacker can already read the database and every file the
 * token protects. It closes the weaker entries: browser pages and sandboxed
 * apps, which can reach the port but not the filesystem.
 */

export const API_TOKEN_HEADER = 'x-operon-token'

let token: string | null = null

export function getApiToken(): string {
  if (!token) {
    // Env override exists for tests and multi-process deploys that need a
    // pre-agreed value; normal runs mint a fresh secret per server process.
    token = process.env.OPERON_API_TOKEN || randomBytes(32).toString('hex')
  }
  return token
}

/**
 * Unit tests drive routes through `app.request()` without a token, and the
 * Playwright test server opts out explicitly — auth there would only test the
 * fixture plumbing, not the product.
 */
export function isApiTokenAuthDisabled(): boolean {
  return process.env.OPERON_DISABLE_API_TOKEN === '1' || process.env.NODE_ENV === 'test'
}

export function apiTokenFilePath(): string {
  return path.join(os.homedir(), '.operon', 'run', 'api-token')
}

/** Write the token where out-of-process local consumers look for it. */
export function publishApiToken(): void {
  const file = apiTokenFilePath()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, getApiToken(), { mode: 0o600 })
  // writeFileSync's mode only applies on create; tighten a pre-existing file too.
  fs.chmodSync(file, 0o600)
}

/** Constant-time compare over digests so length differences leak nothing. */
function tokenMatches(presented: string): boolean {
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(getApiToken()).digest()
  return timingSafeEqual(a, b)
}

function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null
  const m = /^Bearer\s+(.+)$/i.exec(authorization)
  return m ? m[1] : null
}

export function createApiTokenMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (isApiTokenAuthDisabled()) return next()
    // Liveness probe: no data, no side effects.
    if (c.req.path === '/api/health') return next()

    // Accept the token from any one of three carriers. "Any match" (not
    // "first present") matters: web-client requests arrive through the tunnel
    // with their own broker `Authorization` header AND the tunnel-injected
    // x-operon-token — the unrelated bearer value must not veto the valid one.
    // The query carrier exists for clients that cannot set headers: <img>
    // attachment loads, WebSocket upgrades, and MCP client configs.
    const candidates = [
      c.req.header(API_TOKEN_HEADER),
      bearerToken(c.req.header('authorization')),
      c.req.query('token'),
    ]
    for (const candidate of candidates) {
      if (candidate && tokenMatches(candidate)) return next()
    }
    return c.json({ error: 'unauthorized' }, 401)
  }
}
