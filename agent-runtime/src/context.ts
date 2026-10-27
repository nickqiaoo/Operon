import { delimiter } from 'node:path'

/**
 * What a runtime needs from the app embedding it: where the agent CLIs live and
 * which environment to run them in. Every member is optional — an empty host
 * spawns each CLI by its bare name from PATH with `process.env`, which is all a
 * terminal-launched Node process needs. Packaged desktop apps are the reason the
 * hooks exist: they start with a minimal env and may ship their own binaries.
 */
export interface RuntimeHost {
  /**
   * Executable for an agent CLI, by CLI id (`'claude-code'`, `'codex'`,
   * `'opencode'`, `'copilot'`, `'qoder'`, `'cursor'`, `'grok'`, `'kimi'`, `'antigravity'`).
   * Undefined lets the provider fall back to the bare command name on PATH.
   */
  resolveBinary?(cliId: string): string | undefined
  /**
   * Base environment, layered UNDER `process.env` — typically the user's login
   * shell, which a GUI app launched from the Dock never inherited.
   */
  shellEnv?(): Record<string, string>
  /** Overrides layered OVER `process.env` — e.g. variables the user set in the app. */
  env?(): Record<string, string>
}

/**
 * The host as providers see it, bound to one runtime instance. Passed down to
 * every provider and session instead of being read from a global, so two
 * runtimes in one process can run with different hosts.
 */
export interface RuntimeContext {
  readonly host: RuntimeHost
  resolveBinary(cliId: string): string | undefined
  /**
   * The environment for a spawned agent: shell env < process.env < host env <
   * `sessionEnv`, with PATH merged across all four instead of overwritten.
   */
  env(sessionEnv?: Record<string, string | undefined>): Record<string, string>
  /**
   * A per-runtime singleton, built on first use and shared by every provider and
   * session of this runtime — usage probes, model caches and the like, which
   * used to be module globals. A value with a `dispose()` method is disposed by
   * `disposeShared()` (what `Runtime.dispose()` calls).
   */
  shared<T>(key: string, create: () => T): T
  /** Dispose every shared value that can be, and forget them all. */
  disposeShared(): Promise<void>
}

function filterEnv(env: Record<string, string | undefined> | undefined): Record<string, string> {
  if (!env) return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!key.trim()) continue
    if (typeof value !== 'string') continue
    result[key] = value
  }
  return result
}

/**
 * Merge PATH from several env layers, preserving order and deduplicating. Later
 * layers' directories come first so they take precedence.
 */
function mergePaths(...envs: Record<string, string>[]): string {
  const seen = new Set<string>()
  const dirs: string[] = []
  for (let i = envs.length - 1; i >= 0; i--) {
    const pathValue = envs[i].PATH
    if (!pathValue) continue
    for (const dir of pathValue.split(delimiter)) {
      if (dir && !seen.has(dir)) {
        seen.add(dir)
        dirs.push(dir)
      }
    }
  }
  return dirs.join(delimiter)
}

const hasDispose = (value: unknown): value is { dispose(): unknown } =>
  typeof value === 'object' && value !== null && typeof (value as { dispose?: unknown }).dispose === 'function'

export function createRuntimeContext(host: RuntimeHost = {}): RuntimeContext {
  const sharedValues = new Map<string, unknown>()
  return {
    host,
    shared<T>(key: string, create: () => T): T {
      if (!sharedValues.has(key)) sharedValues.set(key, create())
      return sharedValues.get(key) as T
    },
    async disposeShared() {
      const values = [...sharedValues.values()]
      sharedValues.clear()
      await Promise.allSettled(values.map(async (value) => {
        if (hasDispose(value)) await value.dispose()
      }))
    },
    resolveBinary: (cliId) => host.resolveBinary?.(cliId),
    env(sessionEnv) {
      const shellEnv = filterEnv(host.shellEnv?.())
      const processEnv = filterEnv(process.env)
      const hostEnv = filterEnv(host.env?.())
      const sesEnv = filterEnv(sessionEnv)
      const merged = { ...shellEnv, ...processEnv, ...hostEnv, ...sesEnv }
      const mergedPath = mergePaths(shellEnv, processEnv, hostEnv, sesEnv)
      if (mergedPath) merged.PATH = mergedPath
      return merged
    },
  }
}
