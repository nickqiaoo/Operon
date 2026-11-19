export interface SshEnvironmentRef {
  id: string
  name: string
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
