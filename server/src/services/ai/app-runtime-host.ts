import type { RuntimeHost } from '@operon/agent-runtime'
import {
  getClaudeCliPath,
  getCodexBinaryPath,
  getCopilotCliPath,
  getOpencodeBinaryPath,
  getKimiCliPath,
  getGrokCliPath,
  getShellEnv,
} from '../adapter/bundled-cli-paths.js'
import { getEnvVars } from '../env-config.js'

const CLI_RESOLVERS: Record<string, () => string | undefined> = {
  'claude-code': getClaudeCliPath,
  codex: getCodexBinaryPath,
  opencode: getOpencodeBinaryPath,
  kimi: getKimiCliPath,
  grok: getGrokCliPath,
  copilot: getCopilotCliPath,
}

/**
 * The XUI/Operon host implementation for runtime providers: resolves the bundled
 * agent CLIs and supplies login-shell + user-configured env. Injected once via
 * `createSessionManager(appRuntimeHost)` so providers never import app packaging
 * modules directly.
 */
export const appRuntimeHost: RuntimeHost = {
  resolveCliPath: (cliId) => CLI_RESOLVERS[cliId]?.(),
  getShellEnv,
  getUserEnv: getEnvVars,
}
