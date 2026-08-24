export interface DetailedContextUsageCategory {
  name: string
  tokens: number
  color: string
  isDeferred?: boolean
}

export interface DetailedContextUsage {
  categories: DetailedContextUsageCategory[]
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  percentage: number
  model: string
  memoryFiles: {
    path: string
    type: string
    tokens: number
  }[]
  isAutoCompactEnabled: boolean
  autoCompactThreshold?: number
  apiUsage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null
}
