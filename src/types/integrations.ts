// Linear × GitHub integration state, as GET /api/integrations/app/status
// reports it (server/src/routes/integrations.ts). Mirrors the server shapes;
// the server is the source of truth.

export interface LinearInstallView {
  orgId: string
  workspaceName: string
  urlKey: string
  appUserId: string
  appUserName: string
  installedByMe: boolean
  linked: boolean
  linearUserId?: string
  linearUserName?: string
  defaultNodeId?: string
  revoked: boolean
}

export interface LinearAppConfig {
  orgId: string
  orgName: string
  urlKey: string
  appUserId: string
  appUserName: string
  linearUserId?: string
  linearUserName?: string
  updatedAt?: number
}

/** The one local default for delegations from Linear (design §8.1). */
export interface LinearDelegationConfig {
  defaultAgentId: number | null
}

export interface GithubInstallView {
  installationId: number
  accountLogin: string
  repos: string[]
}

export type IntegrationFlowKind = 'linear/install' | 'linear/link' | 'github/install' | 'github/link'

export interface IntegrationFlowState {
  status: 'pending' | 'done' | 'error'
  message?: string
  startedAt: number
}

export interface IntegrationAppStatus {
  saasConnected: boolean
  brokerError?: string
  linear: {
    enabled: boolean
    installs: LinearInstallView[]
    local: LinearAppConfig | null
  }
  github: {
    enabled: boolean
    appSlug: string
    login: string
    installs: GithubInstallView[]
    personalToken: boolean
  }
  delegation: LinearDelegationConfig
  flows: Partial<Record<IntegrationFlowKind, IntegrationFlowState>>
}

export interface GithubCoverageProject {
  projectId: number
  name: string
  repo: string | null
  covered: boolean
  installationId: number | null
}

export interface LinearPublishOptions {
  teams: Array<{ id: string; name: string; key: string }>
  /** The team this project published to last time, if any. */
  defaultTeamId: string | null
}
