import { createModelManager } from 'operon-agents'

/** Read-only built-in catalog, independent of saved keys and custom registrations. */
export const piCatalog = createModelManager().models

// These providers need project/account/region setup beyond the API key form.
const SPECIAL_SETUP = new Set([
  'amazon-bedrock', 'azure', 'google-vertex', 'cloudflare-workers-ai', 'cloudflare-ai-gateway',
])

export function apiKeyCatalogProviders() {
  return piCatalog.getProviders().filter((provider) =>
    provider.auth.apiKey && !SPECIAL_SETUP.has(provider.id) && piCatalog.getModels(provider.id).length > 0,
  )
}
