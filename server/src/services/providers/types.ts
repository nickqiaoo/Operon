export interface ProviderModelInfo {
  id: string
  label: string
}

export interface ProviderConfig {
  id: string
  label: string
  logo: string
  command: string
  args: string[]
  models: ProviderModelInfo[]
  defaultModel?: string
  supportsSetModel?: boolean
  getArgs(modelId?: string): string[]
}
