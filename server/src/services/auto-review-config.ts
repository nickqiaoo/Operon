import type { StorageAdapter } from '../storage/interface.js'

const KV_CONFIG = 'operon:auto_review_model'

export interface AutoReviewConfig {
  /** The `provider/model` that reviews tool calls in Auto mode. Empty: the session's own model. */
  modelId: string
}

let _storage: StorageAdapter | null = null

export function initAutoReviewConfigService(storage: StorageAdapter): void {
  _storage = storage
}

export function getAutoReviewConfig(): AutoReviewConfig {
  return { modelId: _storage?.get<Partial<AutoReviewConfig>>(KV_CONFIG)?.modelId ?? '' }
}

export function setAutoReviewConfig(config: AutoReviewConfig): void {
  _storage?.set(KV_CONFIG, { modelId: config.modelId })
}
