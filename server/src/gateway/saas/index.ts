import { beginSaasOAuth, type SaasAuthProvider } from './oauth-flow.js'
import { getSaasConfig, setSaasConfig, clearSaasConfig } from './config.js'
import { BROKER_URL } from './broker.js'
import { startSaasRuntime, stopSaasRuntime, isSaasRuntimeRunning } from '../../services/saas-runtime.js'
import { SAAS_LOGIN_ERROR, SaasLoginError, type SaasLoginErrorPayload, normalizeSaasLoginError } from './errors.js'

// Orchestrates desktop SaaS login: loopback OAuth → broker access token → register
// this machine as a node → persist the node token (which the tunnel agent reads).

let activeFlow: { cancel(): void } | null = null
let lastLoginError: SaasLoginErrorPayload | undefined

function decodeSub(jwt: string): string | undefined {
  try {
    const payload = jwt.split('.')[1]
    if (!payload) return undefined
    return (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub?: string }).sub
  } catch {
    return undefined
  }
}

export interface SaasStatus {
  connected: boolean
  running: boolean
  userId?: string
  nodeId?: string
  label?: string
  loginError?: SaasLoginErrorPayload
}

export function saasStatus(): SaasStatus {
  const c = getSaasConfig()
  return {
    connected: !!c.nodeToken,
    running: isSaasRuntimeRunning(),
    userId: c.userId,
    nodeId: c.nodeId,
    label: c.label,
    loginError: lastLoginError,
  }
}

export async function saasLogin(provider: SaasAuthProvider, label: string): Promise<{ authorizeUrl: string }> {
  const base = BROKER_URL
  setSaasConfig({ label })
  lastLoginError = undefined

  activeFlow?.cancel()
  const flow = await beginSaasOAuth(base, provider)
  activeFlow = flow

  // Fire-and-forget: when the user authorizes, register the node and persist the
  // node token. The renderer polls /status to observe the result.
  flow.done
    .then(async ({ accessToken }) => {
      const userId = decodeSub(accessToken)
      // Reuse the node from a previous login on THIS machine (same user) so each
      // re-login doesn't strand an orphaned, forever-offline node. The broker only
      // honors the id when it still belongs to this user, else it mints a new one.
      const prev = getSaasConfig()
      const reuseNodeId = prev.userId && prev.userId === userId ? prev.nodeId : undefined
      const res = await fetch(`${base}/auth/nodes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ label, nodeId: reuseNodeId }),
      })
      if (!res.ok) {
        throw new SaasLoginError(SAAS_LOGIN_ERROR.nodeRegistrationFailed, `Node registration failed: ${res.status}`)
      }
      const node = (await res.json()) as { nodeId?: string; nodeToken?: string }
      setSaasConfig({
        accessToken,
        userId,
        nodeId: node.nodeId,
        nodeToken: node.nodeToken,
        label,
        connectedAt: Date.now(),
      })
      lastLoginError = undefined
      console.log('[saas] connected', { userId, nodeId: node.nodeId })
      startSaasRuntime() // bring this machine online immediately
    })
    .catch((err) => {
      lastLoginError = normalizeSaasLoginError(err)
      console.error('[saas] login failed', err)
    })
    .finally(() => {
      if (activeFlow === flow) activeFlow = null
    })

  return { authorizeUrl: flow.authorizeUrl }
}

export async function saasLogout(): Promise<void> {
  stopSaasRuntime()
  lastLoginError = undefined
  const c = getSaasConfig()
  // Best-effort revoke so the node disappears from the user's device list.
  if (c.accessToken && c.nodeId) {
    try {
      await fetch(`${BROKER_URL}/auth/nodes/${c.nodeId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${c.accessToken}` },
      })
    } catch {
      // offline / token expired — clear locally anyway
    }
  }
  clearSaasConfig()
}
