/**
 * Host services a runtime provider needs from its embedding environment:
 * locating agent CLI binaries and reading environment variables. The embedding
 * app injects a full implementation via `createSessionManager(host)`; a bare
 * default keeps providers usable in tests / headless contexts with no wiring.
 *
 * This is the seam that lets `runtime-provider` be extracted as a standalone
 * SDK: it no longer reaches into app modules (bundled-cli-paths, env-config)
 * directly — the host supplies those, so an SDK consumer plugs in their own.
 */
export interface RuntimeHost {
  /**
   * Resolve the executable path for an agent CLI by its adapter id
   * ('claude-code' | 'codex' | 'opencode' | 'kimi'). Return undefined to let the
   * provider fall back to resolving the bare command name via PATH.
   */
  resolveCliPath(cliId: string): string | undefined
  /**
   * Full login-shell environment, merged into spawned child processes. Return {}
   * to use only process.env (sufficient outside packaged desktop apps, where
   * process.env is already complete).
   */
  getShellEnv(): Record<string, string>
  /** User-configured environment variable overrides. Return {} for none. */
  getUserEnv(): Record<string, string>
}

/**
 * Minimal host: no login-shell probing, no bundled-path config, no user env.
 * CLI resolution returns undefined so providers spawn the bare command via PATH.
 */
const bareHost: RuntimeHost = {
  resolveCliPath: () => undefined,
  getShellEnv: () => ({}),
  getUserEnv: () => ({}),
}

let currentHost: RuntimeHost = bareHost

/** Install the host used by all runtime providers (called by createSessionManager). */
export function setRuntimeHost(host: RuntimeHost): void {
  currentHost = host
}

/** The currently-installed host (bare default until setRuntimeHost is called). */
export function getRuntimeHost(): RuntimeHost {
  return currentHost
}
