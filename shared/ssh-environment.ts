export interface SshEnvironmentRef {
  id: string
  name: string
  /** Directory of an attached local workspace or a scoped remote worktree. */
  cwd?: string
}

export type SshAuthMethod = 'key' | 'password'

export interface SshEnvironmentProfile extends SshEnvironmentRef {
  host: string
  port: number
  username: string
  cwd: string
  hostFingerprint: string
  keyPath: string
  authMethod?: SshAuthMethod
}

export interface SshHostKeyChallenge {
  status: 'confirm-host-key'
  fingerprint: string
}
