import type { StorageAdapter } from '../storage/interface.js'
import { DeepSeekWebProvider, DirectFetchProvider, FirecrawlProvider, TavilyProvider, webSearchTool, webFetchTool } from 'operon-agents/tools'
import { keyedProviders, type KeyedProvider, type WebToolUpdate, type WebToolSettings } from '../../../shared/web-tools.js'

const storageKey = 'operon:web_tools'
let storage: StorageAdapter | undefined
export function initWebTools(store: StorageAdapter) {
  storage = store
}

function config(): WebToolUpdate {
  return storage?.get<WebToolUpdate>(storageKey) ?? { search: 'off', fetch: 'off', keys: {} }
}

export function getWebToolSettings(): WebToolSettings {
  const { search, fetch, keys } = config()
  return { search, fetch, configured: keyedProviders.filter(id => !!keys[id]) }
}

export function getWebToolKey(provider: KeyedProvider): string {
  return config().keys[provider] ?? ''
}

export class MissingWebToolKeyError extends Error {}

export function saveWebToolSettings(update: WebToolUpdate) {
  const keys = { ...config().keys, ...update.keys }
  for (const provider of [update.search, update.fetch]) {
    if (provider !== 'off' && provider !== 'direct' && !keys[provider]) {
      throw new MissingWebToolKeyError(`An API key is required for ${provider}.`)
    }
  }
  storage!.set(storageKey, { search: update.search, fetch: update.fetch, keys })
  return getWebToolSettings()
}

export function configuredWebTools() {
  const { search, fetch, keys } = config()
  const providers = {
    deepseek: () => new DeepSeekWebProvider({ apiKey: keys.deepseek! }),
    firecrawl: () => new FirecrawlProvider({ apiKey: keys.firecrawl! }),
    tavily: () => new TavilyProvider({ apiKey: keys.tavily! }),
    direct: () => new DirectFetchProvider(),
  }
  return [
    ...(search !== 'off' ? [webSearchTool(providers[search]())] : []),
    ...(fetch !== 'off' ? [webFetchTool(providers[fetch]())] : []),
  ]
}
