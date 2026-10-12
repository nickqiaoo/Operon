import type { RuntimeHost } from '@operon/agent-runtime'
import {
  getClaudeCliPath,
  getCodexBinaryPath,
  getAntigravityCliPath,
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
  antigravity: getAntigravityCliPath,
}

/**
 * Operon's host for the agent runtime: resolves the agent CLIs (bundled or
 * configured in Settings) and supplies the login-shell env plus the variables
 * the user set in the app. Handed to `createRuntime` in state.ts, so providers
 * never import app packaging modules directly.
 */
export const appRuntimeHost: RuntimeHost = {
  resolveBinary: (cliId) => CLI_RESOLVERS[cliId]?.(),
  shellEnv: getShellEnv,
  env: getEnvVars,
}
