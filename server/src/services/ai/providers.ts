import { getSessionManager } from './state.js'
import { getProviderModelsCached } from './provider-models-cache.js'
import { isAdapterAvailable } from '../adapter/bundled-cli-paths.js'

export function getProviders() {
  const sessionManager = getSessionManager()
  const allowed = providerAllowlist()
  return sessionManager
    .listProviders()
    .filter((p) => !allowed || allowed.has(p.id))
    .map((p) => ({
      ...p,
      available: isAdapterAvailable(p.id),
    }))
}

/**
 * `OPERON_PROVIDERS=opencode,codex` narrows what this node advertises.
 *
 * A node can only run the CLIs someone installed on it, and `available` alone
 * does not keep a client off the missing ones: the desktop dropdown greys them
 * out, but the phone client lists every provider the node returns. On a
 * headless node — nobody there to install anything, and the App Store review
 * machine in particular — that turns most of the picker into entries whose only
 * outcome is a failed chat.
 *
 * Unset, which is every desktop, this is a no-op.
 */
function providerAllowlist(): Set<string> | null {
  const ids = (process.env.OPERON_PROVIDERS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  return ids.length ? new Set(ids) : null
}

// Reads through the process-level SWR cache: returns instantly from cache when
// warm (refreshing in the background if stale), only fetching live on a cold
// miss. See provider-models-cache.ts.
export async function getProviderModels(providerId: string) {
  return getProviderModelsCached(providerId)
}
