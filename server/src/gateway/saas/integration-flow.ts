import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { beginBrokerFlow } from '../../services/integrations/broker-client.js'

// The loopback half of the Linear / GitHub install and link flows
// (docs/linear-github/design.md §4). Same shape as the broker login
// (oauth-flow.ts) with two differences: the broker is asked for the browser
// URL with this machine's node token, and what comes back is an id — an org,
// an installation, a login — never a token.

const LOOPBACK_PORTS = [53431, 53432, 53433, 53434, 53435]

export type IntegrationFlowKind = 'linear/install' | 'linear/link' | 'github/install' | 'github/link'

export interface IntegrationFlowResult {
  kind: string
  org?: string
  installation?: string
  login?: string
}

export interface IntegrationFlow {
  authorizeUrl: string
  done: Promise<IntegrationFlowResult>
  cancel(): void
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
  throw new Error('all loopback ports busy (53431-53435)')
}

export async function beginIntegrationFlow(kind: IntegrationFlowKind): Promise<IntegrationFlow> {
  const { server, port } = await bindLoopback()
  // The broker only accepts this exact path for integration redirects
  // (isAllowedIntegrationRedirectURI in broker/integrations.go).
  const redirectUri = `http://127.0.0.1:${port}/integrations/callback`
  let authorizeUrl: string
  try {
    authorizeUrl = (await beginBrokerFlow(kind, redirectUri)).url
  } catch (err) {
    server.close()
    throw err
  }

  const done = new Promise<IntegrationFlowResult>((resolve, reject) => {
    const cleanup = () => server.close()
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Authorization timed out after 5 minutes. Please try again.'))
    }, 5 * 60 * 1000)

    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      if (u.pathname !== '/integrations/callback') {
        res.statusCode = 404
        res.end('not found')
        return
      }
      clearTimeout(timeout)
      const error = u.searchParams.get('error')
      if (error) {
        respondHtml(res, `<h2>Authorization failed (${escapeHtml(error)}). You can close this page.</h2>`)
        cleanup()
        reject(new Error(describeFlowError(error)))
        return
      }
      respondHtml(res, '<h2>Done. You can close this page and return to operon.</h2>')
      cleanup()
      resolve({
        kind: u.searchParams.get('kind') ?? kind,
        org: u.searchParams.get('org') ?? undefined,
        installation: u.searchParams.get('installation') ?? undefined,
        login: u.searchParams.get('login') ?? undefined,
      })
    })
  })

  return { authorizeUrl, done, cancel: () => server.close() }
}

export function describeFlowError(code: string): string {
  switch (code) {
    case 'not_installed':
      return 'The operon agent is not installed in that Linear workspace yet. Ask a workspace admin to install it first.'
    case 'access_denied':
      return 'Authorization was cancelled.'
    case 'token_exchange_failed':
      return 'Linear rejected the authorization code. Please try again.'
    case 'github_failed':
      return 'GitHub did not return the installation. Please try again.'
    default:
      return `Authorization failed: ${code}`
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)
}

function respondHtml(res: ServerResponse, body: string): void {
  res.statusCode = 200
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(
    `<!doctype html><meta charset="utf-8"><style>body{font-family:-apple-system,sans-serif;padding:40px;color:#222}</style>${body}`,
  )
}
