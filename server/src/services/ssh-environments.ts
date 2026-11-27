import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { LocalEnvironment } from 'operon-agents'
import { statSync } from 'node:fs'
import { SshEnvironment, type EnvironmentDeclaration, type SessionBindings, type SessionEnvironmentBinding } from 'operon-agents/advanced'
import type { SshEnvironmentProfile, SshEnvironmentRef } from '../../../shared/ssh-environment.js'
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

export function additionalSshRefs(ids: string[] | undefined, rootId?: string, localDir?: string): SshEnvironmentRef[] {
  if (ids === undefined) return []
  if (!Array.isArray(ids) || ids.includes(rootId ?? '') || new Set(ids).size !== ids.length) {
    throw new Error('Select each SSH environment only once.')
  }
  return ids.map(id => {
    if (id === 'local') return localRef(rootId, localDir)
    const { name } = getSshEnvironment(id)
    return { id, name }
  })
}

export function localRef(rootId?: string, cwd?: string): SshEnvironmentRef {
  if (!rootId) throw new Error('Local is already the default environment.')
  if (!cwd || !path.isAbsolute(cwd) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('Choose an existing absolute directory on the Operon host.')
  }
  return { id: 'local', name: 'Local', cwd }
}

export function sshProfile(ref: SshEnvironmentRef) {
  const profile = getSshEnvironment(ref.id)
  return ref.cwd ? { ...profile, cwd: ref.cwd } : profile
}

/**
 * An additional environment as the session declares it: the saved machine (or host directory)
 * it stands for, and the name the model writes as `target`.
 */
export interface DeclaredEnvironment extends SshEnvironmentRef {
  target: string
}

/** What a session's declaration keeps about each environment, so a reopen can connect it again. */
function metadataOf(ref: SshEnvironmentRef): Record<string, string> {
  return ref.id === 'local' ? { id: 'local', cwd: ref.cwd ?? '' } : { id: ref.id, ...(ref.cwd ? { cwd: ref.cwd } : {}) }
}

/** The session's root environment, in every session the app creates. */
const ROOT_TARGET = 'main'

/**
 * A `target` name for each ref: its display name in the framework's spelling (lower-case, at most
 * 32 characters), unique within the session. Chosen once, when the environment is declared; the
 * declaration keeps it, so renaming the saved machine later does not move it.
 */
export function declareEnvironments(refs: readonly SshEnvironmentRef[], taken: Iterable<string> = []): DeclaredEnvironment[] {
  const used = new Set([ROOT_TARGET, ...taken])
  return refs.map(ref => {
    const slug = ref.id === 'local'
      ? 'local'
      : ref.name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+|-+$/g, '')
    const base = (slug || 'ssh').slice(0, 28)
    let target = base
    for (let n = 2; used.has(target); n++) target = `${base}-${n}`
    used.add(target)
    return { ...ref, target }
  })
}

/** The additional environments a stored declaration lists, as refs the app can connect again. */
export function declaredEnvironments(declaration: EnvironmentDeclaration | undefined): DeclaredEnvironment[] {
  if (!declaration) return []
  return declaration.environments.flatMap(entry => {
    const id = entry.metadata?.id
    if (entry.name === declaration.root || !id) return []
    const cwd = entry.metadata?.cwd
    return [{ id, name: entry.description ?? entry.name, target: entry.name, ...(cwd ? { cwd } : {}) }]
  })
}

/**
 * One environment's binding. The session owns the connection it opens: `release` closes it when
 * the environment is removed or the session closes.
 */
export function environmentBinding(ref: SshEnvironmentRef): SessionEnvironmentBinding {
  const declared = { description: ref.name, metadata: metadataOf(ref) }
  if (ref.id === 'local') {
    return {
      ...declared,
      environment: async () => {
        if (!ref.cwd || !statSync(ref.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Local workspace unavailable.')
        return new LocalEnvironment(ref.cwd)
      },
    }
  }
  let connection: SshEnvironment | undefined
  return {
    ...declared,
    environment: async () => (connection = (await connectSshEnvironment(sshProfile(ref))).environment),
    release: () => {
      void connection?.close().catch((error: unknown) => console.warn('[SSH] Connection cleanup failed:', error))
      connection = undefined
    },
  }
}

export function sessionEnvironmentBindings(root: SshEnvironmentProfile | undefined, additional: readonly DeclaredEnvironment[] = []): SessionBindings | undefined {
  const primary = root ? sshSessionBindings(root) : undefined
  if (!additional.length) return primary
  return {
    ...primary,
    additionalEnvironments: Object.fromEntries(additional.map(ref => [ref.target, environmentBinding(ref)])),
  }
}
