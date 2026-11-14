import { apiKeyCatalogProviders, piCatalog } from './pi-catalog.js'
import type { StorageAdapter } from '../storage/interface.js'
import { customProviderBaseUrl, type CustomProviderInfo } from '../../../shared/provider-config.js'

const KV_KEY = 'ai:provider_configs'

export interface ProviderConfig {
  apiKey?: string
  baseUrl?: string
  enabled?: boolean
  /**
   * Model IDs entered by hand. Used for providers whose API has no "list models"
   * endpoint — these are merged into the chat model picker so the user can still
   * select a model without a successful live fetch.
   */
  manualModels?: string[]
  /** Set on user-added providers only (`custom-*`): their name and wire API. */
  custom?: CustomProviderInfo
}

/** Trim, drop blanks, and dedupe a hand-entered model-id list (order preserved). */
export function normalizeManualModels(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    const id = raw.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result.length > 0 ? result : undefined
}

export type ProviderConfigs = Record<string, ProviderConfig>

export interface ProviderModel {
  id: string
  name: string
  description?: string
}

export interface ProviderMeta {
  label: string
  defaultBaseUrl: string
  logo: string
}

/** Pi is the only source of built-in providers and endpoint defaults. */
export const PROVIDER_META: Record<string, ProviderMeta> = Object.fromEntries(
  apiKeyCatalogProviders().map((provider) => [provider.id, {
    label: provider.name,
    defaultBaseUrl: provider.baseUrl ?? '',
    logo: provider.id,
  }]),
)

let _storage: StorageAdapter | null = null
const configListeners = new Set<(providerId: string) => void>()

/** Be told after a provider's config is saved or removed. Returns the unsubscribe. */
export function onProviderConfigChange(listener: (providerId: string) => void): () => void {
  configListeners.add(listener)
  return () => configListeners.delete(listener)
}

export function initProviderConfigService(storage: StorageAdapter): void {
  _storage = storage
}

export function getProviderConfigs(): ProviderConfigs {
  if (!_storage) return {}
  return _storage.get<ProviderConfigs>(KV_KEY) ?? {}
}

export function getProviderConfig(providerId: string): ProviderConfig {
  return getProviderConfigs()[providerId] ?? {}
}

export function setProviderConfig(providerId: string, config: ProviderConfig): void {
  if (!_storage) return
  const all = getProviderConfigs()
  all[providerId] = config
  _storage.set(KV_KEY, all)
  for (const listener of configListeners) listener(providerId)
}

export function deleteProviderConfig(providerId: string): void {
  if (!_storage) return
  const all = getProviderConfigs()
  delete all[providerId]
  _storage.set(KV_KEY, all)
  for (const listener of configListeners) listener(providerId)
}

export function getProviderMeta(providerId: string): ProviderMeta {
  const custom = getProviderConfig(providerId).custom
  if (custom) return { label: custom.name, defaultBaseUrl: '', logo: 'endpoint' }
  return PROVIDER_META[providerId] ?? { label: providerId, defaultBaseUrl: '', logo: '' }
}

/** Custom endpoints need an address; built-in providers need an API key. */
export function isProviderUsable(providerId: string, config: ProviderConfig): boolean {
  if (config.custom) return Boolean(config.baseUrl)
  return Boolean(PROVIDER_META[providerId] && config.apiKey)
}

function normalizeProviderConfig(config: ProviderConfig): ProviderConfig {
  return {
    apiKey: config.apiKey?.trim() || undefined,
    baseUrl: config.baseUrl?.trim() || undefined,
    enabled: config.enabled,
    custom: config.custom,
  }
}

/**
 * Built-ins use Pi's chat catalog unless their endpoint is overridden.
 * An override lists models from that endpoint using the provider's wire API.
 */
export async function fetchProviderModels(
  providerId: string,
  configOverride?: ProviderConfig
): Promise<ProviderModel[]> {
  const config = configOverride
    ? normalizeProviderConfig(configOverride)
    : normalizeProviderConfig(getProviderConfig(providerId))
  const apiKey = config.apiKey

  if (config.custom) {
    // A key is optional here: a self-hosted endpoint often has none.
    if (!config.baseUrl) throw new Error(`No base URL configured for ${config.custom.name}`)
    const base = customProviderBaseUrl(config.custom.api, config.baseUrl)
    return config.custom.api === 'anthropic-messages'
      ? fetchAnthropicModels(apiKey ?? '', base)
      : listOpenAiCompatibleModels(`${base}/models`, apiKey ?? '', config.custom.name)
  }

  if (!apiKey) {
    throw new Error(`No API key configured for provider: ${providerId}`)
  }

  if (!PROVIDER_META[providerId]) throw new Error(`Unknown provider: ${providerId}`)
  if (config.baseUrl) {
    const api = piCatalog.getModels(providerId)[0]?.api
    if (api === 'anthropic-messages') {
      return fetchAnthropicModels(apiKey, customProviderBaseUrl('anthropic-messages', config.baseUrl))
    }
    if (api === 'google-generative-ai') return fetchGoogleModels(apiKey, config.baseUrl)
    const base = customProviderBaseUrl('openai-completions', config.baseUrl)
    return listOpenAiCompatibleModels(`${base}/models`, apiKey, PROVIDER_META[providerId].label)
  }
  return piCatalog.getModels(providerId).map((model) => ({ id: model.id, name: model.name }))
}

// ---------------------------------------------------------------------------
// Provider-specific fetchers
// ---------------------------------------------------------------------------

async function fetchAnthropicModels(apiKey: string, baseUrl?: string): Promise<ProviderModel[]> {
  const base = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')
  const res = await fetch(`${base}/v1/models`, {
    headers: {
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
      'anthropic-version': '2023-06-01',
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Anthropic API error ${res.status}: ${body}`)
  }
  const data = await res.json() as { data: Array<{ id: string; display_name?: string }> }
  return (data.data ?? []).map((m) => ({
    id: m.id,
    name: m.display_name || m.id,
  }))
}

async function fetchGoogleModels(apiKey: string, baseUrl: string): Promise<ProviderModel[]> {
  const base = baseUrl.replace(/\/+$/, '')
  const url = new URL(`${base}/models`)
  url.searchParams.set('key', apiKey)
  const res = await fetch(url.toString())
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Google API error ${res.status}: ${body}`)
  }
  const data = await res.json() as {
    models: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }>
  }
  return (data.models ?? [])
    .filter((model) => model.supportedGenerationMethods?.includes('generateContent'))
    .map((model) => ({ id: model.name.replace(/^models\//, ''), name: model.displayName || model.name.replace(/^models\//, '') }))
}

/** `GET /models` in the OpenAI shape, sorted by id. Omit authorization for keyless endpoints. */
async function listOpenAiCompatibleModels(
  modelsUrl: string,
  apiKey: string,
  providerLabel: string,
): Promise<ProviderModel[]> {
  const res = await fetch(modelsUrl, {
    headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${providerLabel} API error ${res.status}: ${body}`)
  }
  // Vercel AI Gateway also lists embedding, image, video, speech… models; others send no `type`.
  const data = await res.json() as {
    data: Array<{ id: string; type?: string; capabilities?: { completion_chat?: boolean; function_calling?: boolean } }>
  }
  return (data.data ?? [])
    .filter((m) => (m.type === undefined || m.type === 'language' || (m.type === 'base' && m.capabilities?.completion_chat === true))
      && m.capabilities?.completion_chat !== false && m.capabilities?.function_calling !== false)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => ({ id: m.id, name: m.id }))
}
