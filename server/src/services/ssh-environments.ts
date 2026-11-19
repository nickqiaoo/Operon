import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { SshEnvironment, type SessionBindings } from 'operon-agents/advanced'
import type { SshEnvironmentProfile } from '../../../shared/ssh-environment.js'
import type { StorageAdapter } from '../storage/interface.js'

const KEY = 'operon:ssh_environments'
const execFileAsync = promisify(execFile)
let storage: Pick<StorageAdapter, 'get' | 'set'> | undefined
let passwordEncryption: SshPasswordEncryption | undefined

interface StoredSshEnvironment extends SshEnvironmentProfile {
  passwordCiphertext?: string
}

export interface SshPasswordEncryption {
  isAvailable?(): boolean
  encryptString(password: string): Buffer
  decryptString(ciphertext: Buffer): string
}

export function initSshEnvironments(store: NonNullable<typeof storage>, encryption?: SshPasswordEncryption): void {
  storage = store
  passwordEncryption = encryption
}

function storedEnvironments(): StoredSshEnvironment[] {
  return storage?.get<StoredSshEnvironment[]>(KEY) ?? []
}

function publicProfile({ passwordCiphertext: _password, ...profile }: StoredSshEnvironment): SshEnvironmentProfile {
  return profile
}

export function listSshEnvironments(): SshEnvironmentProfile[] {
  return storedEnvironments().map(publicProfile)
}

export function getSshEnvironment(id: string): SshEnvironmentProfile {
  const profile = storedEnvironments().find((item) => item.id === id)
  if (!profile) throw new Error('This SSH environment is unavailable. Check Settings → Operon.')
  return publicProfile(profile)
}

function savedPasswordProfile(profile: SshEnvironmentProfile) {
  const saved = storedEnvironments().find((item) => item.id === profile.id)
  if (
    saved?.authMethod !== 'password' || !saved.passwordCiphertext ||
    saved.host !== profile.host || saved.port !== profile.port || saved.username !== profile.username ||
    (profile.hostFingerprint && saved.hostFingerprint !== profile.hostFingerprint)
  ) throw new Error('Enter the SSH password for this host and user.')
  return { ciphertext: saved.passwordCiphertext, fingerprint: saved.hostFingerprint }
}

function sshPasswordEncryption(): SshPasswordEncryption {
  if (!passwordEncryption || passwordEncryption.isAvailable?.() === false) {
    throw new Error('System secure storage for SSH passwords is unavailable on this Operon host.')
  }
  return passwordEncryption
}

export function saveSshEnvironment(profile: SshEnvironmentProfile, password?: string): void {
  let entry: StoredSshEnvironment = profile
  if (profile.authMethod === 'password') {
    const encryption = sshPasswordEncryption()
    const passwordCiphertext = password === undefined
      ? savedPasswordProfile(profile).ciphertext
      : encryption.encryptString(password).toString('base64')
    entry = { ...profile, passwordCiphertext }
  }
  const profiles = storedEnvironments()
  storage?.set(KEY, profiles.some(({ id }) => id === profile.id)
    ? profiles.map((item) => item.id === profile.id ? entry : item)
    : [...profiles, entry])
}

export function deleteSshEnvironment(id: string): void {
  storage?.set(KEY, storedEnvironments().filter((item) => item.id !== id))
}

const hostKeyFingerprint = (key: Buffer): string =>
  `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`

async function knownHostKeys(host: string, port: number) {
  const target = port === 22 ? host : `[${host}]:${port}`
  const { stdout } = await execFileAsync('ssh-keygen', ['-F', target, '-f', path.join(homedir(), '.ssh', 'known_hosts')],
    { timeout: 2_000, windowsHide: true }).catch(() => ({ stdout: '' }))
  const trusted = new Set<string>()
  const revoked = new Set<string>()
  for (const line of stdout.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields[0]?.startsWith('#') || fields[0] === '@cert-authority') continue
    const isRevoked = fields[0] === '@revoked'
    const key = fields[isRevoked ? 3 : 2]
    if (key) (isRevoked ? revoked : trusted).add(hostKeyFingerprint(Buffer.from(key, 'base64')))
  }
  return { trusted, revoked }
}

export class SshHostKeyConfirmationRequired extends Error {
  constructor(readonly fingerprint: string) {
    super('Confirm the SSH host key in Settings → Operon.')
  }
}

export async function connectSshEnvironment(profile: SshEnvironmentProfile, suppliedPassword?: string): Promise<{ environment: SshEnvironment; fingerprint: string }> {
  const usePassword = profile.authMethod === 'password'
  const saved = usePassword && suppliedPassword === undefined ? savedPasswordProfile(profile) : undefined
  const password = usePassword
    ? saved ? sshPasswordEncryption().decryptString(Buffer.from(saved.ciphertext, 'base64')) : suppliedPassword
    : undefined
  const agent = process.env.SSH_AUTH_SOCK
  if (!usePassword && !profile.keyPath && !agent) {
    throw new Error('No SSH agent is available on the Operon host. Set a private key path in Settings → Operon.')
  }
  const expectedFingerprint = profile.hostFingerprint || saved?.fingerprint
  const { trusted, revoked } = expectedFingerprint
    ? { trusted: new Set([expectedFingerprint]), revoked: new Set<string>() }
    : await knownHostKeys(profile.host, profile.port)
  let fingerprint = ''
  let rejectedFingerprint: string | undefined
  const keyPath = profile.keyPath.startsWith('~/') ? path.join(homedir(), profile.keyPath.slice(2)) : profile.keyPath
  try {
    const environment = await SshEnvironment.create({
      host: profile.host,
      port: profile.port,
      username: profile.username,
      cwd: profile.cwd,
      name: profile.name,
      ...(usePassword ? { password } : keyPath ? { keyPaths: [keyPath] } : {}),
      hostVerifier: (key) => {
        const presented = hostKeyFingerprint(key)
        if (trusted.has(presented) && !revoked.has(presented)) {
          fingerprint = presented
          return true
        }
        rejectedFingerprint = presented
        return false
      },
      forwardProxyEnv: false,
      extraOptions: {
        readyTimeout: 10_000,
        keepaliveInterval: 15_000,
        ...(!usePassword && !keyPath && agent ? { agent } : {}),
      },
    })
    return { environment, fingerprint }
  } catch (error) {
    if (rejectedFingerprint) {
      if (revoked.has(rejectedFingerprint)) throw new Error(`The host key for ${profile.name} has been revoked.`)
      if (trusted.size > 0 || revoked.size > 0) throw new Error(`The host key for ${profile.name} does not match a trusted fingerprint.`)
      throw new SshHostKeyConfirmationRequired(rejectedFingerprint)
    }
    const reason = error instanceof Error ? error.message : 'Connection failed'
    throw new Error(`Could not open SSH environment ${profile.name}. ${reason}`)
  }
}

export function sshSessionBindings(profile: SshEnvironmentProfile): SessionBindings {
  let connection: SshEnvironment | undefined
  return {
    environment: async () => {
      connection = (await connectSshEnvironment(profile)).environment
      return connection
    },
    release: () => {
      // Begin transport shutdown without waiting for a close event that may have already fired.
      void connection?.close().catch((error: unknown) => console.warn('[SSH] Connection cleanup failed:', error))
    },
  }
}
