export interface DetailedContextUsageCategory {
  name: string
  tokens: number
  /**
   * The producer's own swatch id — the Claude SDK's terminal palette, or the Operon
   * engine's semantic names. Neither vocabulary is theme-aware, so the panel paints
   * from `kind` and row order instead (see `contextCategorySlices`).
   */
  color: string
  isDeferred?: boolean
  /**
   * 'used' occupies the window, 'free' is what is left, 'buffer' is the compaction
   * reserve, 'deferred' rows are out-of-window tool schemas excluded from the usage
   * math. Classify on this, never on the English name. Optional: a producer predating
   * it omits it and consumers fall back to `isDeferred` and the name.
   */
  kind?: 'used' | 'free' | 'buffer' | 'deferred'
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
