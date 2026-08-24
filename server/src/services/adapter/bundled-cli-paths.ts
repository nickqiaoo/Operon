import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { shellEnvSync } from 'shell-env'
import { getCliPathConfig, CLI_ADAPTER_IDS, type CliAdapterId } from '../cli-path-config.js'

type CliPathSource = 'manual' | 'auto' | 'missing'

export interface CliPathInfo {
  path?: string
  resolvedPath?: string
  available: boolean
  source: CliPathSource
  command: string
}

const ADAPTER_COMMANDS: Record<CliAdapterId, readonly [string, ...string[]]> = {
  'claude-code': ['claude'],
  codex: ['codex'],
  opencode: ['opencode'],
  kimi: ['kimi'],
  grok: ['grok'],
  // Matches CURSOR_BIN in agent-runtime/src/providers/cursor/config.ts.
  cursor: ['cursor-agent'],
  copilot: ['copilot'],
}

const execFileAsync = promisify(execFile)

const SHELL_PATH_CACHE_TTL_MS = 5_000

let cachedShellPathDirs: { dirs: string[]; expiresAt: number } | null = null
let cachedShellEnv: { env: Record<string, string>; expiresAt: number } | null = null

/**
 * Get the full shell environment (cached).
 * Useful for passing to child processes spawned from packaged Electron apps
 * where process.env is incomplete.
 */
export function getShellEnv(): Record<string, string> {
  const now = Date.now()
  if (cachedShellEnv && cachedShellEnv.expiresAt > now) {
    return cachedShellEnv.env
  }

  let env: Record<string, string> = {}
  try {
    env = shellEnvSync() as Record<string, string>
  } catch {
    // Fall back to empty — process.env will still be used by the caller
  }

  cachedShellEnv = { env, expiresAt: now + SHELL_PATH_CACHE_TTL_MS }
  return env
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK)
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}

function getShellPathDirs(): string[] {
  const now = Date.now()
  if (cachedShellPathDirs && cachedShellPathDirs.expiresAt > now) {
    return cachedShellPathDirs.dirs
  }

  // Both PATHs, merged — neither is a superset of the other.
  //
  // Under Electron the process PATH is the sparse one macOS hands a GUI app, and
  // the login shell's is what actually has the user's tools; the login shell
  // must therefore be consulted. Under systemd it is the other way round: the
  // unit sets PATH explicitly (that is where a headless node's Node install and
  // its global bins live) while the login shell knows nothing about it. This
  // used to *replace* the process PATH with the shell's, so a CLI installed for
  // the service was invisible to it and every adapter reported as missing.
  //
  // Process PATH first: it is the deployment's explicit statement of intent.
  const sources = [process.env.PATH ?? '']
  try {
    const shellPath = shellEnvSync().PATH
    if (shellPath) sources.push(shellPath)
  } catch {
    // Login shell detection failing just means the process PATH stands alone.
  }

  const seen = new Set<string>()
  const dirs = sources
    .flatMap((value) => value.split(delimiter))
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0 && !seen.has(dir) && seen.add(dir))

  cachedShellPathDirs = { dirs, expiresAt: now + SHELL_PATH_CACHE_TTL_MS }
  return dirs
}

function getExecutableNames(command: string): string[] {
  if (process.platform !== 'win32') return [command]
  if (/\.[^./\\]+$/.test(command)) return [command]

  const pathExt = process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM'
  const extensions = pathExt
    .split(';')
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0)

  return extensions.map((extension) => `${command}${extension.toLowerCase()}`)
}

function resolveCommandFromShellPath(command: string): string | undefined {
  for (const dir of getShellPathDirs()) {
    for (const executableName of getExecutableNames(command)) {
      const candidatePath = join(dir, executableName)
      if (isExecutable(candidatePath)) {
        return candidatePath
      }
    }
  }
  return undefined
}

export function getCliPathInfo(adapterId: CliAdapterId): CliPathInfo {
  const path = getCliPathConfig(adapterId)
  const commands = ADAPTER_COMMANDS[adapterId]
  const command = commands[0]

  if (path && isExecutable(path)) {
    return {
      path,
      resolvedPath: path,
      available: true,
      source: 'manual',
      command,
    }
  }

  for (const candidate of commands) {
    const resolvedPath = resolveCommandFromShellPath(candidate)
    if (resolvedPath) {
      return {
        path,
        resolvedPath,
        available: true,
        source: 'auto',
        command,
      }
    }
  }

  return {
    path,
    available: false,
    source: 'missing',
    command,
  }
}

/**
 * Resolve the Claude Code CLI path.
 */
export function getClaudeCliPath(): string | undefined {
  return getCliPathInfo('claude-code').resolvedPath
}

/**
 * Resolve the Codex binary path.
 */
export function getCodexBinaryPath(): string | undefined {
  return getCliPathInfo('codex').resolvedPath
}

/**
 * Resolve the OpenCode binary path.
 */
export function getOpencodeBinaryPath(): string | undefined {
  return getCliPathInfo('opencode').resolvedPath
}

/**
 * Resolve the Kimi CLI binary path.
 */
export function getKimiCliPath(): string | undefined {
  return getCliPathInfo('kimi').resolvedPath
}

/**
 * Resolve the Grok Build CLI binary path.
 */
export function getGrokCliPath(): string | undefined {
  return getCliPathInfo('grok').resolvedPath
}

/**
 * Resolve the GitHub Copilot CLI path.
 */
export function getCopilotCliPath(): string | undefined {
  return getCliPathInfo('copilot').resolvedPath
}

export interface CliVersionInfo {
  /** Semver parsed out of `--version`, when the probe succeeded. */
  version?: string
  /** Human-readable failure reason — written to be shown to the user as-is. */
  error?: string
  /** Set when the CLI works but is older than what this build was tested with. */
  warning?: string
}

/**
 * Lowest CLI version this build is known to work with. Deliberately advisory:
 * the SDKs pin their runtime with an npm range, but the stdio JSON-RPC protocol
 * between them is not versioned in lockstep, so an older CLI usually still
 * works. Blocking on it would strand users who have a working setup, and since
 * we no longer bundle a runtime they would have no way back.
 */
const CLI_MIN_TESTED_VERSIONS: Partial<Record<CliAdapterId, string>> = {
  // `@github/copilot-sdk` declares `"@github/copilot": "^1.0.73"`.
  copilot: '1.0.73',
}

/** -1 / 0 / 1, comparing dotted numeric versions. Missing parts count as 0. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

const VERSION_PROBE_TIMEOUT_MS = 5_000
const VERSION_CACHE_TTL_MS = 60_000

const versionCache = new Map<CliAdapterId, { info: CliVersionInfo; expiresAt: number }>()

/**
 * Run `<cli> --version` and report the version, or a message explaining why it
 * could not run.
 *
 * Why this exists as a separate step from `getCliPathInfo`: resolving a path
 * only proves a file is there and has +x. It does NOT prove the thing can
 * actually start, and the way it fails is invisible. A CLI installed via npm is
 * a shebang script run by whatever `node` is on PATH, and both Claude Code and
 * Copilot import builtins (`node:sea`) that older Node releases don't have — the
 * child then dies during module linking, before it writes a single byte of
 * protocol. The SDK doesn't notice: `CopilotClient.start()` resolves as soon as
 * the process is spawned in stdio mode, so the failure only surfaces later as an
 * RPC that never answers. Probing here converts that silent hang into a sentence
 * someone can act on.
 *
 * Cached per adapter, so this costs one spawn a minute, not one per session.
 */
export async function probeCliVersion(adapterId: CliAdapterId): Promise<CliVersionInfo> {
  const now = Date.now()
  const cached = versionCache.get(adapterId)
  if (cached && cached.expiresAt > now) return cached.info

  const info = await runVersionProbe(adapterId)
  versionCache.set(adapterId, { info, expiresAt: now + VERSION_CACHE_TTL_MS })
  return info
}

async function runVersionProbe(adapterId: CliAdapterId): Promise<CliVersionInfo> {
  const command = ADAPTER_COMMANDS[adapterId][0]
  const resolvedPath = getCliPathInfo(adapterId).resolvedPath
  if (!resolvedPath) return { error: `\`${command}\` was not found on your PATH.` }

  let stdout: string
  let stderr: string
  try {
    const result = await execFileAsync(resolvedPath, ['--version'], {
      timeout: VERSION_PROBE_TIMEOUT_MS,
      env: { ...process.env, ...getShellEnv() },
    })
    stdout = result.stdout
    stderr = result.stderr
  } catch (error) {
    return { error: describeProbeFailure(command, error) }
  }

  // Formats differ per CLI ("2.1.220 (Claude Code)", "GitHub Copilot CLI 1.0.68.")
  // — take the first semver-looking token rather than parsing each one.
  const version = /(\d+\.\d+\.\d+)/.exec(`${stdout}\n${stderr}`)?.[1]
  if (!version) return { error: `\`${command} --version\` printed no recognizable version.` }

  const minTested = CLI_MIN_TESTED_VERSIONS[adapterId]
  if (minTested && compareVersions(version, minTested) < 0) {
    return {
      version,
      warning: `Detected ${command} ${version}; this build is tested against ${minTested}+. It will probably still work — update if you hit trouble.`,
    }
  }
  return { version }
}

function describeProbeFailure(command: string, error: unknown): string {
  const err = error as { stderr?: string; message?: string; code?: string; killed?: boolean }
  const stderr = err.stderr ?? ''

  // An npm-installed CLI runs under whatever `node` is on PATH. Both Claude Code
  // and Copilot statically import `node:sea` (Node 20.12+), so an older Node
  // kills the child during module linking with this exact code.
  if (/ERR_UNKNOWN_BUILTIN_MODULE|ERR_MODULE_NOT_FOUND/.test(stderr)) {
    return `\`${command}\` needs a newer Node.js (20.12+) than the one on your PATH. Update Node, or install ${command} as a standalone binary so it stops depending on it.`
  }
  if (err.killed || err.code === 'ETIMEDOUT') {
    return `\`${command} --version\` did not finish within ${VERSION_PROBE_TIMEOUT_MS / 1000}s.`
  }
  const detail = stderr.trim().split('\n')[0] || err.message || 'unknown error'
  return `\`${command} --version\` failed: ${detail}`
}

/**
 * Check if an adapter's CLI dependency is available.
 */
/**
 * Adapters whose runtime ships as an npm dependency rather than a binary the
 * user installs — `@google/gemini-cli-core` and our own direct-API provider.
 * There is nothing on PATH to look for, so they are available whenever the app
 * is.
 *
 * `copilot` used to be on this list. It is not any more: the bundled
 * `@github/copilot` platform package is a 235M native binary that the build now
 * excludes, so Copilot resolves from the user's PATH exactly like Claude Code
 * does — which means its availability has to be checked, not assumed.
 *
 * Note what this does NOT claim: these still need credentials before a turn
 * will run. `available` answers "is the code here", not "is it usable".
 */
const BUNDLED_RUNTIME_ADAPTERS = new Set(['gemini', 'custom'])

/**
 * Check if an adapter's CLI dependency is available.
 *
 * Deliberately has no permissive fallback. This used to end in `default: return
 * true`, which meant an adapter nobody had thought about was reported as ready
 * to use — `cursor` shells out to `cursor-agent` and was claimed available on
 * machines that had never heard of it. Falling back to *unavailable* makes the
 * failure mode "a working adapter shows as missing", which someone notices and
 * fixes, instead of "a missing adapter shows as working", which is only
 * discovered by a user whose first message fails.
 */
export function isAdapterAvailable(adapterId: string): boolean {
  if (BUNDLED_RUNTIME_ADAPTERS.has(adapterId)) return true
  if ((CLI_ADAPTER_IDS as readonly string[]).includes(adapterId)) {
    return !!getCliPathInfo(adapterId as CliAdapterId).resolvedPath
  }
  return false
}
