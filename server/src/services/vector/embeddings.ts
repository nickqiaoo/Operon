/**
 * Embedding configuration and generation using local LLM (node-llama-cpp).
 *
 * Replaces the previous multi-provider system with fully local inference.
 */
import type { StorageAdapter } from '../../storage/interface.js'
import { getLocalLLM } from './local-llm.js'

const CONFIG_KEY = 'embedding-provider-config'

export interface EmbeddingConfig {
  enabled: boolean
  dimensions?: number // auto-detected on first embed
}

const DEFAULT_CONFIG: EmbeddingConfig = {
  enabled: false,
}

let kvStore: StorageAdapter | null = null

export function initEmbeddingConfig(storage: StorageAdapter): void {
  kvStore = storage
}

export function getEmbeddingConfig(): EmbeddingConfig {
  if (!kvStore) return { ...DEFAULT_CONFIG }
  const stored = kvStore.get<EmbeddingConfig>(CONFIG_KEY)
  return { ...DEFAULT_CONFIG, ...stored }
}

export function updateEmbeddingConfig(
  config: Partial<EmbeddingConfig>,
): EmbeddingConfig {
  if (!kvStore) throw new Error('Embedding config not initialized')
  const current = getEmbeddingConfig()
  const updated = { ...current, ...config }
  kvStore.set(CONFIG_KEY, updated)
  return updated
}

/**
 * Generate embedding for text using local LLM.
 * Returns null if not configured/enabled or on error.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  const config = getEmbeddingConfig()
  if (!config.enabled) return null

  try {
    return await getLocalLLM().embed(text)
  } catch (err) {
    console.warn(
      '[Embedding] Failed to generate:',
      err instanceof Error ? err.message : err,
    )
    return null
  }
}
