import type { StorageAdapter } from '../storage/interface.js'

const KV_CONFIG = 'gateway:diff_worker'

export interface DiffPreviewConfig {
  workerUrl: string
  workerApiKey: string
}

let _storage: StorageAdapter | null = null

export function initDiffPreviewConfigService(storage: StorageAdapter): void {
  _storage = storage
}

export function getDiffPreviewConfig(): DiffPreviewConfig {
  if (!_storage) return { workerUrl: '', workerApiKey: '' }
  const saved = _storage.get<{ workerUrl?: string; workerApiKey?: string }>(KV_CONFIG) ?? {}
  return {
    workerUrl: saved.workerUrl ?? '',
    workerApiKey: saved.workerApiKey ?? '',
  }
}

export function setDiffPreviewConfig(config: Partial<DiffPreviewConfig>): void {
  if (!_storage) return
  const current = getDiffPreviewConfig()
  _storage.set(KV_CONFIG, {
    workerUrl: config.workerUrl ?? current.workerUrl,
    workerApiKey: config.workerApiKey ?? current.workerApiKey,
  })
}
