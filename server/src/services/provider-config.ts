import type { StorageAdapter } from '../storage/interface.js'

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

export const PROVIDER_META: Record<string, ProviderMeta> = {
  anthropic: { label: 'Anthropic', defaultBaseUrl: 'https://api.anthropic.com', logo: 'anthropic' },
  openai:    { label: 'OpenAI',    defaultBaseUrl: 'https://api.openai.com',      logo: 'openai' },
  google:    { label: 'Google',    defaultBaseUrl: 'https://generativelanguage.googleapis.com', logo: 'google' },
  deepseek:  { label: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com',    logo: 'deepseek' },
  kimi:      { label: 'Kimi',     defaultBaseUrl: 'https://api.moonshot.cn',      logo: 'moonshot' },
  glm:       { label: 'GLM',      defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', logo: 'zhipu' },
  minimax:   { label: 'MiniMax',  defaultBaseUrl: 'https://api.minimax.chat/v1', logo: 'minimax' },
  grok:      { label: 'Grok',     defaultBaseUrl: 'https://api.x.ai',            logo: 'xai' },
  openrouter:{ label: 'OpenRouter', defaultBaseUrl: 'https://openrouter.ai/api', logo: 'openrouter' },
  ollama:    { label: 'Ollama',     defaultBaseUrl: 'http://localhost:11434',      logo: 'ollama' },
}

let _storage: StorageAdapter | null = null

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
}

export function deleteProviderConfig(providerId: string): void {
  if (!_storage) return
  const all = getProviderConfigs()
  delete all[providerId]
  _storage.set(KV_KEY, all)
}

export function getProviderMeta(providerId: string): ProviderMeta {
  return PROVIDER_META[providerId] ?? { label: providerId, defaultBaseUrl: '', logo: '' }
}

function normalizeProviderConfig(config: ProviderConfig): ProviderConfig {
  return {
    apiKey: config.apiKey?.trim() || undefined,
    baseUrl: config.baseUrl?.trim() || undefined,
    enabled: config.enabled,
  }
}

/**
 * Fetch available models from the provider's API.
 */
export async function fetchProviderModels(
  providerId: string,
  configOverride?: ProviderConfig
): Promise<ProviderModel[]> {
  const config = configOverride
    ? normalizeProviderConfig(configOverride)
    : normalizeProviderConfig(getProviderConfig(providerId))
  const apiKey = config.apiKey

  if (providerId === 'ollama') {
    return fetchOllamaModels(config.baseUrl)
  }

  if (!apiKey) {
    throw new Error(`No API key configured for provider: ${providerId}`)
  }

  switch (providerId) {
    case 'anthropic': return fetchAnthropicModels(apiKey, config.baseUrl)
    case 'openai':    return fetchOpenAiModels(apiKey, config.baseUrl)
    case 'google':    return fetchGoogleModels(apiKey, config.baseUrl)
    case 'deepseek':  return fetchOpenAiCompatibleModels(apiKey, config.baseUrl ?? 'https://api.deepseek.com', 'deepseek')
    case 'kimi':      return fetchOpenAiCompatibleModels(apiKey, config.baseUrl ?? 'https://api.moonshot.cn', 'kimi')
    case 'glm':       return fetchOpenAiCompatibleModels(apiKey, config.baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4', 'glm')
    case 'minimax':   return fetchOpenAiCompatibleModels(apiKey, config.baseUrl ?? 'https://api.minimax.chat/v1', 'minimax')
    case 'grok':      return fetchOpenAiCompatibleModels(apiKey, config.baseUrl ?? 'https://api.x.ai', 'grok')
    case 'openrouter': return fetchOpenAiCompatibleModels(apiKey, config.baseUrl ?? 'https://openrouter.ai/api', 'openrouter')
    default:
      throw new Error(`Unknown provider: ${providerId}`)
  }
}

// ---------------------------------------------------------------------------
// Provider-specific fetchers
// ---------------------------------------------------------------------------

async function fetchAnthropicModels(apiKey: string, baseUrl?: string): Promise<ProviderModel[]> {
  const base = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')
  const res = await fetch(`${base}/v1/models`, {
    headers: {
      'x-api-key': apiKey,
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

async function fetchOpenAiModels(apiKey: string, baseUrl?: string): Promise<ProviderModel[]> {
  const base = (baseUrl || 'https://api.openai.com').replace(/\/$/, '')
  const res = await fetch(`${base}/v1/models`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`OpenAI API error ${res.status}: ${body}`)
  }
  const data = await res.json() as { data: Array<{ id: string }> }
  return (data.data ?? [])
    .filter((m) => /^gpt-|^o[0-9]|^chatgpt/.test(m.id))
    .sort((a, b) => b.id.localeCompare(a.id))
    .map((m) => ({ id: m.id, name: m.id }))
}

async function fetchGoogleModels(apiKey: string, baseUrl?: string): Promise<ProviderModel[]> {
  const base = (baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/$/, '')
  const res = await fetch(`${base}/v1beta/models?key=${apiKey}`)
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Google API error ${res.status}: ${body}`)
  }
  const data = await res.json() as { models: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }> }
  return (data.models ?? [])
    .filter((m) => m.name.includes('gemini') && (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => ({
      id: m.name.replace('models/', ''),
      name: m.displayName || m.name.replace('models/', ''),
    }))
}

async function fetchOllamaModels(baseUrl?: string): Promise<ProviderModel[]> {
  const base = (baseUrl || 'http://localhost:11434').replace(/\/$/, '')
  const res = await fetch(`${base}/api/tags`)
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Ollama API error ${res.status}: ${body}`)
  }
  const data = await res.json() as { models: Array<{ name: string; model?: string }> }
  return (data.models ?? [])
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => ({ id: m.name, name: m.name }))
}

/**
 * Generic OpenAI-compatible fetcher used by DeepSeek, Kimi, GLM, MiniMax, Grok.
 */
async function fetchOpenAiCompatibleModels(
  apiKey: string,
  baseUrl: string,
  providerLabel: string,
): Promise<ProviderModel[]> {
  const base = baseUrl.replace(/\/$/, '')
  // Some providers include /v1 in their base, others don't
  const modelsUrl = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`
  const res = await fetch(modelsUrl, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${providerLabel} API error ${res.status}: ${body}`)
  }
  const data = await res.json() as { data: Array<{ id: string }> }
  return (data.data ?? [])
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => ({ id: m.id, name: m.id }))
}
