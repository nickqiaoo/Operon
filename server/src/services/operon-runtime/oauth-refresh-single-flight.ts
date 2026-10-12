/**
 * One token refresh per refresh token, however many callers ask at once.
 *
 * Grafana and Linear rotate refresh tokens and treat a second use of an old one as theft: the
 * second refresh fails with `invalid_grant` and the provider revokes the new token too. The MCP
 * SDK refreshes inside each request that gets a 401, so when a token expires, every concurrent
 * request on the shared gateway upstream (a heartbeat probe, an agent listing tools, the Connect
 * button) refreshes on its own with the same old token — and the user ends up signed out.
 *
 * The SDK takes no hook for this (the framework's transport doesn't accept a `fetch`), so this
 * wraps the process's `fetch`: a refresh-token grant for a token already being refreshed (or just
 * refreshed) gets the same response instead of a second request. Every other request passes
 * straight through.
 */

interface SettledResponse {
  status: number
  statusText: string
  headers: Array<[string, string]>
  body: string
}

/** How long a finished refresh still answers for its old token: a caller whose 401 arrived late. */
const REUSE_WINDOW_MS = 60_000

const flights = new Map<string, Promise<SettledResponse>>()
let installed = false

export function installRefreshSingleFlight(): void {
  if (installed) return
  installed = true
  const base = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const key = refreshKey(input, init)
    if (key === undefined) return base(input, init)
    let flight = flights.get(key)
    if (flight === undefined) {
      flight = settle(base(input, init))
      flights.set(key, flight)
      const forget = () => {
        setTimeout(() => {
          if (flights.get(key) === flight) flights.delete(key)
        }, REUSE_WINDOW_MS).unref()
      }
      // A network failure is worth retrying right away; a provider answer is not.
      flight.then(forget, () => {
        if (flights.get(key) === flight) flights.delete(key)
      })
    }
    return flight.then(
      ({ status, statusText, headers, body }) => new Response(body, { status, statusText, headers }),
    )
  }
}

async function settle(pending: Promise<Response>): Promise<SettledResponse> {
  const response = await pending
  return {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
    body: await response.text(),
  }
}

/** `<token endpoint> <refresh token>` for a refresh-token grant, otherwise undefined. */
export function refreshKey(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): string | undefined {
  if (init?.method?.toUpperCase() !== 'POST') return undefined
  const body = init.body
  const params =
    body instanceof URLSearchParams ? body : typeof body === 'string' ? new URLSearchParams(body) : undefined
  if (params?.get('grant_type') !== 'refresh_token') return undefined
  const token = params.get('refresh_token')
  if (token === null) return undefined
  const url = input instanceof Request ? input.url : String(input)
  return `${url} ${token}`
}
