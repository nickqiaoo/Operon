import { startAgent, type AgentHandle } from '../../../tunnel-agent/src/connection.js'
import { brokerHttpBase } from '../../../tunnel-agent/src/saasConfig.js'
import { getSaasConfig, clearSaasConfig } from '../gateway/saas/config.js'
import { BROKER_URL } from '../gateway/saas/broker.js'
import { getApiToken, isApiTokenAuthDisabled } from './api-token.js'

// Runs the tunnel agent IN-PROCESS (Electron main) so that once the user has signed
// in, this machine is reachable from the web app with zero manual steps. The agent
// forwards tunneled requests to this same server over loopback.

let handle: AgentHandle | null = null

export function isSaasRuntimeRunning(): boolean {
  return handle !== null
}

/** Start the embedded agent if SaaS is configured and not already running. */
export function startSaasRuntime(): boolean {
  if (handle) return true
  const cfg = getSaasConfig()
  if (!cfg.nodeToken) return false

  const port = process.env.OPERON_PORT
  if (!port) return false

  handle = startAgent({
    brokerUrl: brokerHttpBase(BROKER_URL),
    secret: cfg.nodeToken,
    nodeId: cfg.nodeId ?? 'node',
    label: cfg.label ?? 'machine',
    localBase: `http://127.0.0.1:${port}`,
    // Same process as the server, so the /api token gate is satisfied directly.
    localToken: isApiTokenAuthDisabled() ? undefined : getApiToken(),
    // A refused token is worthless — revoked, or minted by a broker this build
    // no longer talks to — and the agent has already given up. Throw it away so
    // the machine reads as disconnected, which is the truth, instead of holding
    // dead credentials and claiming to be online.
    onAuthRejected: () => {
      console.warn('[saas] broker refused this node token — clearing it')
      stopSaasRuntime()
      clearSaasConfig()
    },
  })
  console.log('[saas] embedded tunnel agent started', { nodeId: cfg.nodeId, broker: BROKER_URL })
  return true
}

export function stopSaasRuntime(): void {
  handle?.stop()
  handle = null
}
