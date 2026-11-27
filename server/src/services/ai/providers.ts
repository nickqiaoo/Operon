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
 * Headless nodes, such as the App Store review machine, can use this to omit
 * providers they do not offer. Clients use `available` to disable entries that
 * are still advertised but whose CLI is missing.
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
