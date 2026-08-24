import type { StorageAdapter } from '../storage/interface.js'

const KV_CONFIG = 'git:commit_message_generator'

export interface CommitMessageConfig {
  /** Runtime provider id used to generate commit messages (e.g. 'claude', 'custom'). */
  providerId: string
  /** Fully-qualified model id within that provider (e.g. 'anthropic/claude-...'). */
  modelId: string
}

let _storage: StorageAdapter | null = null

export function initCommitMessageConfigService(storage: StorageAdapter): void {
  _storage = storage
}

export function getCommitMessageConfig(): CommitMessageConfig {
  if (!_storage) return { providerId: '', modelId: '' }
  const saved = _storage.get<{ providerId?: string; modelId?: string }>(KV_CONFIG) ?? {}
  return {
    providerId: saved.providerId ?? '',
    modelId: saved.modelId ?? '',
  }
}

export function setCommitMessageConfig(config: Partial<CommitMessageConfig>): void {
  if (!_storage) return
  const current = getCommitMessageConfig()
  _storage.set(KV_CONFIG, {
    providerId: config.providerId ?? current.providerId,
    modelId: config.modelId ?? current.modelId,
  })
}
