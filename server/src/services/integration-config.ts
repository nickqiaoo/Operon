import type { StorageAdapter } from '../storage/interface.js'

export interface LinearIntegrationConfig {
  apiKey: string
  workspaceName: string
  updatedAt: number
}

export interface GithubIntegrationConfig {
  token: string
  login: string
  updatedAt: number
}

const KV_LINEAR = 'integration:linear'
const KV_GITHUB = 'integration:github'

let _storage: StorageAdapter | null = null

export function initIntegrationConfigService(storage: StorageAdapter): void {
  _storage = storage
}

export function getLinearConfig(): LinearIntegrationConfig | null {
  if (!_storage) return null
  const saved = _storage.get<LinearIntegrationConfig>(KV_LINEAR)
  if (!saved || typeof saved.apiKey !== 'string' || saved.apiKey.length === 0) {
    return null
  }
  return {
    apiKey: saved.apiKey,
    workspaceName: saved.workspaceName ?? '',
    updatedAt: saved.updatedAt ?? 0,
  }
}

export function setLinearConfig(config: { apiKey: string; workspaceName: string }): void {
  if (!_storage) return
  _storage.set<LinearIntegrationConfig>(KV_LINEAR, {
    apiKey: config.apiKey,
    workspaceName: config.workspaceName,
    updatedAt: Date.now(),
  })
}

export function deleteLinearConfig(): void {
  if (!_storage) return
  _storage.delete(KV_LINEAR)
}

export function getGithubConfig(): GithubIntegrationConfig | null {
  if (!_storage) return null
  const saved = _storage.get<GithubIntegrationConfig>(KV_GITHUB)
  if (!saved || typeof saved.token !== 'string' || saved.token.length === 0) {
    return null
  }
  return {
    token: saved.token,
    login: saved.login ?? '',
    updatedAt: saved.updatedAt ?? 0,
  }
}

export function setGithubConfig(config: { token: string; login: string }): void {
  if (!_storage) return
  _storage.set<GithubIntegrationConfig>(KV_GITHUB, {
    token: config.token,
    login: config.login,
    updatedAt: Date.now(),
  })
}

export function deleteGithubConfig(): void {
  if (!_storage) return
  _storage.delete(KV_GITHUB)
}
