import type { StorageAdapter } from '../storage/interface.js'

// Local integration settings. Third-party credentials are NOT here any more
// for Linear: the workspace agent's token lives on the broker
// (docs/linear-github/design.md §3), and what the desktop keeps is ids and
// names. The GitHub personal token remains for the manual "Create PR" button;
// task PRs go through the GitHub App (github-app.ts).

export interface GithubIntegrationConfig {
  token: string
  login: string
  updatedAt: number
}

/** The Linear workspace this machine works in (broker-confirmed; no token). */
export interface LinearAppConfig {
  orgId: string
  orgName: string
  urlKey: string
  appUserId: string
  appUserName: string
  linearUserId?: string
  linearUserName?: string
  updatedAt: number
}

/**
 * How a delegation from Linear starts on this machine. The repository comes
 * from the issue itself (a `repo:owner/name` label); the only thing the
 * desktop adds is which agent runs it. Unset = the task is created but waits
 * for a person to dispatch it.
 */
export interface LinearDelegationConfig {
  defaultAgentId: number | null
}

const KV_GITHUB = 'integration:github'
const KV_LINEAR_APP = 'integration:linear_app'
const KV_LINEAR_DELEGATION = 'integration:linear_delegation'
const KV_LINEAR_PUBLISH_TEAMS = 'integration:linear_publish_teams'

let _storage: StorageAdapter | null = null

export function initIntegrationConfigService(storage: StorageAdapter): void {
  _storage = storage
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

export function getLinearAppConfig(): LinearAppConfig | null {
  if (!_storage) return null
  const saved = _storage.get<LinearAppConfig>(KV_LINEAR_APP)
  if (!saved || typeof saved.orgId !== 'string' || !saved.orgId) return null
  return saved
}

export function setLinearAppConfig(config: Omit<LinearAppConfig, 'updatedAt'>): void {
  if (!_storage) return
  _storage.set<LinearAppConfig>(KV_LINEAR_APP, { ...config, updatedAt: Date.now() })
}

export function deleteLinearAppConfig(): void {
  if (!_storage) return
  _storage.delete(KV_LINEAR_APP)
}

export function getLinearDelegationConfig(): LinearDelegationConfig {
  const saved = _storage?.get<LinearDelegationConfig>(KV_LINEAR_DELEGATION)
  return { defaultAgentId: typeof saved?.defaultAgentId === 'number' ? saved.defaultAgentId : null }
}

export function setLinearDelegationConfig(config: LinearDelegationConfig): void {
  _storage?.set<LinearDelegationConfig>(KV_LINEAR_DELEGATION, { defaultAgentId: config.defaultAgentId })
}

/** The Linear team a project last published to — a preselection, not a rule. */
export function getLinearPublishTeam(projectId: number): string | null {
  const saved = _storage?.get<Record<string, string>>(KV_LINEAR_PUBLISH_TEAMS)
  const v = saved?.[String(projectId)]
  return typeof v === 'string' && v ? v : null
}

export function rememberLinearPublishTeam(projectId: number, teamId: string): void {
  if (!_storage) return
  const saved = _storage.get<Record<string, string>>(KV_LINEAR_PUBLISH_TEAMS) ?? {}
  _storage.set<Record<string, string>>(KV_LINEAR_PUBLISH_TEAMS, { ...saved, [String(projectId)]: teamId })
}
