import { BROKER_URL } from '../../gateway/saas/broker.js'
import { getSaasConfig } from '../../gateway/saas/config.js'

// The desktop's client for the broker's /integrations/* endpoints
// (docs/linear-github/design.md §4–§5). Authenticates with this machine's node
// token: it never expires, is revocable per device, and names the user — the
// 48h access token from login is not refreshed on the desktop.

export class BrokerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'BrokerError'
  }
}

export interface LinearInstallView {
  orgId: string
  workspaceName: string
  urlKey: string
  appUserId: string
  appUserName: string
  installedByMe: boolean
  linked: boolean
  linearUserId?: string
  linearUserName?: string
  defaultNodeId?: string
  revoked: boolean
}

export interface GithubInstallView {
  installationId: number
  accountLogin: string
  repos: string[]
}

export interface IntegrationsStatus {
  linear: { enabled: boolean; installs: LinearInstallView[] }
  github: { enabled: boolean; appSlug: string; login: string; installs: GithubInstallView[] }
}

/** The sticky rows a desktop may claim for itself. */
export type StickyRouteKind = 'linear_issue' | 'github_pr'

export function brokerCredentials(): { token: string; nodeId: string } | null {
  const c = getSaasConfig()
  if (!c.nodeToken || !c.nodeId) return null
  return { token: c.nodeToken, nodeId: c.nodeId }
}

export function isBrokerConnected(): boolean {
  return brokerCredentials() !== null
}

async function brokerFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const creds = brokerCredentials()
  if (!creds) {
    throw new BrokerError(401, 'saas_not_connected', 'Sign in on the Remote tab first.')
  }
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${creds.token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const res = await fetch(`${BROKER_URL}${path}`, { ...init, headers })
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (!res.ok) {
    const body = (json ?? {}) as { code?: string; error?: string; message?: string }
    throw new BrokerError(
      res.status,
      body.code ?? body.error ?? `http_${res.status}`,
      body.message ?? body.error ?? `Broker request failed: ${res.status}`,
    )
  }
  return json as T
}

export function fetchIntegrationsStatus(): Promise<IntegrationsStatus> {
  return brokerFetch<IntegrationsStatus>('/integrations/status')
}

/** Asks the broker for the browser URL that starts an install / link flow. */
export function beginBrokerFlow(
  kind: 'linear/install' | 'linear/link' | 'github/install' | 'github/link',
  redirectUri: string,
): Promise<{ url: string }> {
  const creds = brokerCredentials()
  const q = new URLSearchParams({ redirect_uri: redirectUri })
  if (creds) q.set('node_id', creds.nodeId)
  return brokerFetch<{ url: string }>(`/integrations/${kind}?${q.toString()}`)
}

export function claimRoutes(routes: Array<{ kind: StickyRouteKind; key: string }>): Promise<{ ok: boolean }> {
  const creds = brokerCredentials()
  return brokerFetch('/integrations/routes', {
    method: 'PUT',
    body: JSON.stringify({ nodeId: creds?.nodeId, routes }),
  })
}

/**
 * Linear GraphQL as the workspace agent. The broker holds the app token; the
 * response is Linear's own (status + body), so errors read the same as a
 * direct call would.
 */
export async function linearGraphQL<T>(
  orgId: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const json = await brokerFetch<{ data?: T; errors?: Array<{ message: string }> }>(
    '/integrations/linear/graphql',
    { method: 'POST', body: JSON.stringify({ orgId, query, variables }) },
  )
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join('; '))
  }
  if (!json.data) throw new Error('Linear API returned no data')
  return json.data
}

export function unlinkLinear(orgId: string): Promise<{ ok: boolean }> {
  return brokerFetch(`/integrations/linear/${encodeURIComponent(orgId)}/identity`, { method: 'DELETE' })
}

export function uninstallLinear(orgId: string): Promise<{ ok: boolean }> {
  return brokerFetch(`/integrations/linear/${encodeURIComponent(orgId)}`, { method: 'DELETE' })
}

export function mintGithubInstallationToken(
  installationId: number,
  repo: string,
): Promise<{ token: string; expiresAt: string; installationId: number; repo: string }> {
  return brokerFetch(`/integrations/github/installations/${installationId}/token`, {
    method: 'POST',
    body: JSON.stringify({ repo }),
  })
}

export function lookupGithubRepo(
  owner: string,
  name: string,
): Promise<{ repo: string; covered: boolean; installationId?: number; accountLogin?: string; appSlug: string }> {
  return brokerFetch(`/integrations/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`)
}

export function forgetGithubInstallation(installationId: number): Promise<{ ok: boolean }> {
  return brokerFetch(`/integrations/github/installations/${installationId}`, { method: 'DELETE' })
}
