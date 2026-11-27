export const searchProviders = ['off', 'deepseek', 'tavily', 'firecrawl'] as const
export const fetchProviders = ['off', 'deepseek', 'tavily', 'firecrawl', 'direct'] as const
export const keyedProviders = ['deepseek', 'firecrawl', 'tavily'] as const
export type KeyedProvider = typeof keyedProviders[number]

export interface WebToolSelection {
  search: typeof searchProviders[number]
  fetch: typeof fetchProviders[number]
}
export interface WebToolSettings extends WebToolSelection {
  configured: KeyedProvider[]
}
export interface WebToolUpdate extends WebToolSelection {
  keys: Partial<Record<KeyedProvider, string>>
}
