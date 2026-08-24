import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { SAAS_LOGIN_ERROR, SaasLoginError } from './errors.js'

// Desktop login to the operon SaaS broker — a clone of the Linear loopback OAuth
// flow (gateway/linear/oauth-flow.ts), pointed at the broker's /auth/* endpoints
// instead of Linear. PKCE, public client, ephemeral 127.0.0.1 listener.

const LOOPBACK_PORTS = [53421, 53422, 53423, 53424, 53425]

// The identity providers the broker knows (broker/oauth.go startAuthorize).
// Apple works over loopback like GitHub does: its form_post callback lands on the
// broker, which then redirects to our 127.0.0.1 listener — no cookie involved.
export type SaasAuthProvider = 'github' | 'apple'

export interface SaasOAuthResult {
  authorizeUrl: string
  redirectUri: string
  /** Resolves with the broker access token once the user authorizes. */
  done: Promise<{ accessToken: string }>
  cancel(): void
}

interface BrokerErrorBody {
  code?: string
  error?: string
  message?: string
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

async function bindLoopback(): Promise<{ server: Server; port: number }> {
  for (const port of LOOPBACK_PORTS) {
    try {
      const server = createServer()
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.removeListener('listening', onListening)
          reject(err)
        }
        const onListening = () => {
          server.removeListener('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, '127.0.0.1')
      })
      return { server, port }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') continue
      throw err
    }
  }
  throw new Error('all loopback ports busy (53421-53425)')
}

export async function beginSaasOAuth(
  brokerUrl: string,
  provider: SaasAuthProvider,
): Promise<SaasOAuthResult> {
  const base = brokerUrl.replace(/\/$/, '')
  const { server, port } = await bindLoopback()
  // The path has to be exactly this. The broker validates a redirect_uri by
  // requiring `/auth/callback` and then checking the origin (see
  // isAllowedRedirectURI in broker/main.go) — a loopback host gets past the
  // origin check on any port, but never on a different path.
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`
  const { verifier, challenge } = generatePkce()

  const authorizeUrl =
    `${base}/auth/authorize?provider=${provider}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code_challenge=${challenge}`

  const done = new Promise<{ accessToken: string }>((resolve, reject) => {
    const cleanup = () => server.close()
    const timeout = setTimeout(() => {
      cleanup()
      reject(new SaasLoginError(SAAS_LOGIN_ERROR.loopbackTimeout, 'Sign-in timed out after 5 minutes. Please try again.'))
    }, 5 * 60 * 1000)

    server.on('request', async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
        if (u.pathname !== '/auth/callback') {
          res.statusCode = 404
          res.end('not found')
          return
        }
        const code = u.searchParams.get('code')
        const error = u.searchParams.get('error')
        const errorCode = u.searchParams.get('error_code')
        const message = u.searchParams.get('message')
        if (error || !code) {
          respondHtml(res, '<h2>Sign-in failed. You can close this page.</h2>')
          clearTimeout(timeout)
          cleanup()
          reject(new SaasLoginError(errorCode ?? error ?? SAAS_LOGIN_ERROR.loginFailed, message ?? error ?? 'No authorization code returned.'))
          return
        }

        respondHtml(res, '<h2>Connected to operon. You can close this page.</h2>')
        clearTimeout(timeout)
        cleanup()

        const tr = await fetch(`${base}/auth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code, code_verifier: verifier }),
        })
        if (!tr.ok) {
          const brokerError = await readBrokerError(tr)
          reject(
            new SaasLoginError(
              brokerError.code ?? SAAS_LOGIN_ERROR.tokenExchangeFailed,
              brokerError.message ?? brokerError.error ?? `Token exchange failed: ${tr.status}`,
            ),
          )
          return
        }
        const data = (await tr.json()) as { access?: string }
        if (!data.access) {
          reject(new Error('no access token in response'))
          return
        }
        resolve({ accessToken: data.access })
      } catch (err) {
        clearTimeout(timeout)
        cleanup()
        reject(err)
      }
    })
  })

  return { authorizeUrl, redirectUri, done, cancel: () => server.close() }
}

async function readBrokerError(res: { json(): Promise<unknown> }): Promise<BrokerErrorBody> {
  try {
    return (await res.json()) as BrokerErrorBody
  } catch {
    return {}
  }
}

function respondHtml(res: ServerResponse, body: string): void {
  res.statusCode = 200
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(
    `<!doctype html><meta charset="utf-8"><style>body{font-family:-apple-system,sans-serif;padding:40px;color:#222}</style>${body}`,
  )
}
