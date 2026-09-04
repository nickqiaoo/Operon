import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile, readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Installing ACP agents that ship as a downloadable binary.
 *
 * This exists because the usual "the user installed a CLI, we find it on PATH"
 * story does not work for them: Antigravity's ACP agent is a ~316MB archive
 * from the ACP registry that unpacks to ~886MB and is never linked into PATH.
 * Asking a user to find that URL, unzip it and paste an absolute path is a bad
 * first run, and the registry's `agent.json` is already a machine-readable
 * install manifest — archive URL, launch command, per-platform — so we consume
 * it instead.
 *
 * Deliberately NOT built on `installExtension`: that one buffers the whole
 * archive in memory and caps it at 64MB. Nearly a gigabyte has to stream to
 * disk and be unpacked by a real unzip, or the app runs out of heap.
 */

/** Where installed agents live. One directory per agent id. */
export function acpAgentsDir(): string {
  return path.join(homedir(), '.operon', 'acp-agents')
}

interface RegistryAgent {
  /** Our adapter id — also the install directory name. */
  readonly id: string
  readonly label: string
  /** The registry's `agent.json`, which carries the per-platform archives. */
  readonly manifestUrl: string
  /** Hosts the archive may come from. A manifest naming anything else is refused. */
  readonly allowedHosts: readonly string[]
}

/**
 * Agents operon can install. Keyed by the CLI adapter id so a successful
 * install is immediately visible to `getCliPathInfo`, whose absolute-path
 * candidates point into `acpAgentsDir()`.
 */
export const INSTALLABLE_ACP_AGENTS: readonly RegistryAgent[] = [
  {
    id: 'antigravity',
    label: 'Antigravity',
    manifestUrl:
      'https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json',
    // Google's own download host. The manifest is fetched over https from a
    // repo we name, but it is still third-party data: pinning the host it may
    // send us to keeps a compromised or edited manifest from turning this into
    // "download and run an arbitrary binary".
    allowedHosts: ['dl.google.com'],
  },
]

export function findInstallableAgent(id: string): RegistryAgent | undefined {
  return INSTALLABLE_ACP_AGENTS.find((a) => a.id === id)
}

/**
 * Registry platform key for this machine, or null when the registry has no
 * build for it (Intel Macs, notably — the Antigravity entry ships every other
 * platform but `darwin-x86_64`).
 */
export function registryPlatformKey(): string | null {
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null
  if (!arch) return null
  if (process.platform === 'darwin') return `darwin-${arch}`
  if (process.platform === 'linux') return `linux-${arch}`
  if (process.platform === 'win32') return `windows-${arch}`
  return null
}

interface ManifestBinary {
  archive: string
  cmd: string
  args?: string[]
}

interface AgentManifest {
  version: string
  binary: ManifestBinary
}

/** What we persist next to an install so a later run knows what is there. */
interface InstalledMarker {
  version: string
  cmd: string
  args: string[]
  installedAt: string
}

export type InstallState = 'idle' | 'downloading' | 'extracting' | 'installing' | 'done' | 'error'

export interface InstallProgress {
  state: InstallState
  /** Bytes fetched so far; only meaningful while downloading. */
  receivedBytes: number
  /** Content-Length, when the server sent one. */
  totalBytes: number
  version?: string
  error?: string
}

const progress = new Map<string, InstallProgress>()

export function getInstallProgress(id: string): InstallProgress {
  return progress.get(id) ?? { state: 'idle', receivedBytes: 0, totalBytes: 0 }
}

/** Read the marker written by a completed install, if there is one. */
export async function readInstalledMarker(id: string): Promise<InstalledMarker | null> {
  try {
    const raw = await readFile(path.join(acpAgentsDir(), id, 'operon-install.json'), 'utf8')
    const parsed = JSON.parse(raw) as InstalledMarker
    return typeof parsed.version === 'string' ? parsed : null
  } catch {
    return null
  }
}

export async function fetchManifest(agent: RegistryAgent): Promise<AgentManifest> {
  const response = await fetch(agent.manifestUrl, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Registry returned ${response.status} for ${agent.label}`)
  const json = (await response.json()) as {
    version?: unknown
    distribution?: { binary?: Record<string, unknown> }
  }
  const key = registryPlatformKey()
  if (!key) throw new Error(`No ${agent.label} build for ${process.platform}/${process.arch}`)

  const entry = json.distribution?.binary?.[key] as ManifestBinary | undefined
  if (!entry?.archive || !entry.cmd) {
    throw new Error(`${agent.label} has no build for ${key}. Supported: ${Object.keys(json.distribution?.binary ?? {}).join(', ')}`)
  }
  const url = new URL(entry.archive)
  if (url.protocol !== 'https:' || !agent.allowedHosts.includes(url.hostname)) {
    throw new Error(`Refusing archive from an unexpected host: ${url.hostname}`)
  }
  return {
    version: typeof json.version === 'string' ? json.version : 'unknown',
    binary: { archive: url.toString(), cmd: entry.cmd, args: entry.args ?? [] },
  }
}

/** Stream the archive to `dest`, reporting bytes as they land. */
async function download(url: string, dest: string, onProgress: (received: number, total: number) => void): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) })
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length') ?? 0)

  let received = 0
  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  body.on('data', (chunk: Buffer) => {
    received += chunk.length
    onProgress(received, total)
  })
  await pipeline(body, createWriteStream(dest))
}

/**
 * Unpack with the OS's own unzip.
 *
 * Node has no bundled zip reader, and the in-house one in `extensions.ts` holds
 * the whole archive plus its expansion in memory — fine for a 2MB extension,
 * fatal for this. `unzip` covers macOS and Linux; Windows gets PowerShell's
 * `Expand-Archive`, which is present on every supported release.
 */
async function extract(archive: string, into: string): Promise<void> {
  await mkdir(into, { recursive: true })
  if (process.platform === 'win32') {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath ${JSON.stringify(archive)} -DestinationPath ${JSON.stringify(into)} -Force`,
    ], { timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 })
    return
  }
  try {
    await execFileAsync('unzip', ['-q', '-o', archive, '-d', into], {
      timeout: 15 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not unpack the archive (${detail}). Is \`unzip\` installed?`)
  }
}

/**
 * A downloaded archive may or may not wrap its payload in a single directory.
 * Return the directory that actually holds `cmd`, so the install works either
 * way rather than depending on how the publisher zipped it.
 */
export async function findPayloadRoot(root: string, cmd: string): Promise<string> {
  const name = path.basename(cmd)
  const direct = path.join(root, name)
  try {
    await stat(direct)
    return root
  } catch {
    // fall through to the single-subdirectory case
  }
  const entries = await readdir(root, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory())
  for (const dir of dirs) {
    try {
      await stat(path.join(root, dir.name, name))
      return path.join(root, dir.name)
    } catch {
      continue
    }
  }
  throw new Error(`Archive does not contain ${name}`)
}

/**
 * Download, unpack and install one registry agent, replacing any previous
 * install atomically.
 *
 * Runs to completion in the background; callers poll `getInstallProgress`.
 * Nothing about it is incremental — a failure part-way leaves the previous
 * install untouched, because the new one is only moved into place once it is
 * whole.
 */
export async function installAcpAgent(agent: RegistryAgent): Promise<void> {
  const set = (patch: Partial<InstallProgress>) => {
    progress.set(agent.id, { ...getInstallProgress(agent.id), ...patch })
  }
  set({ state: 'downloading', receivedBytes: 0, totalBytes: 0, error: undefined })

  const staging = await mkdtemp(path.join(tmpdir(), `operon-acp-${agent.id}-`))
  try {
    const manifest = await fetchManifest(agent)
    set({ version: manifest.version })

    const archivePath = path.join(staging, 'agent.zip')
    // Throttled to whole percent: this fires per chunk on a ~316MB download.
    let lastReported = -1
    await download(manifest.binary.archive, archivePath, (received, total) => {
      const pct = total > 0 ? Math.floor((received / total) * 100) : -1
      if (pct !== lastReported) {
        lastReported = pct
        set({ receivedBytes: received, totalBytes: total })
      }
    })

    set({ state: 'extracting' })
    const unpacked = path.join(staging, 'unpacked')
    await extract(archivePath, unpacked)

    set({ state: 'installing' })
    const payload = await findPayloadRoot(unpacked, manifest.binary.cmd)
    const marker: InstalledMarker = {
      version: manifest.version,
      cmd: path.basename(manifest.binary.cmd),
      args: manifest.binary.args ?? [],
      installedAt: new Date().toISOString(),
    }
    await writeFile(path.join(payload, 'operon-install.json'), JSON.stringify(marker, null, 2))
    // The archive may not carry the +x bit through every unzip implementation.
    await chmod(path.join(payload, marker.cmd), 0o755).catch(() => {})

    const target = path.join(acpAgentsDir(), agent.id)
    await mkdir(acpAgentsDir(), { recursive: true })
    const previous = `${target}.old-${Date.now()}`
    let hadPrevious = false
    try {
      await rename(target, previous)
      hadPrevious = true
    } catch {
      // Nothing installed yet.
    }
    try {
      await rename(payload, target)
    } catch (error) {
      if (hadPrevious) await rename(previous, target).catch(() => {})
      throw error
    }
    if (hadPrevious) await rm(previous, { recursive: true, force: true })

    set({ state: 'done' })
  } catch (error) {
    set({ state: 'error', error: error instanceof Error ? error.message : String(error) })
    throw error
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** Remove an installed agent. */
export async function uninstallAcpAgent(id: string): Promise<void> {
  await rm(path.join(acpAgentsDir(), id), { recursive: true, force: true })
  progress.delete(id)
}
