/**
 * Daily self-update of the CLIs the Claude Code and Codex SDKs drive
 * (Settings → Claude Code / Codex → Auto-update). The SDKs spawn whatever CLI
 * is installed on the machine, so keeping that CLI current is what keeps them
 * working against new models and protocol changes.
 *
 * Each CLI updates itself with its own `update` subcommand (`claude update`,
 * `codex update`), which also handles package-manager installs.
 */
export const CLI_AUTO_UPDATE_ADAPTER_IDS = ['claude-code', 'codex'] as const

export type CliAutoUpdateAdapterId = (typeof CLI_AUTO_UPDATE_ADAPTER_IDS)[number]

export type CliAutoUpdateOutcome = 'updated' | 'up-to-date' | 'failed'

export interface CliAutoUpdateLastRun {
  /** Epoch ms the run finished. */
  finishedAt: number
  trigger: 'scheduled' | 'manual'
  outcome: CliAutoUpdateOutcome
  /** `--version` before the update, when it could be read. */
  fromVersion?: string
  /** `--version` after the update, when it could be read. */
  toVersion?: string
  /** Why the run failed — written to be shown as-is. */
  error?: string
}

export interface CliAutoUpdateStatus {
  enabled: boolean
  /** An update is running right now. */
  running: boolean
  lastRun?: CliAutoUpdateLastRun
  /** Epoch ms of the next scheduled check, when enabled. */
  nextCheckAt?: number
}

export type CliAutoUpdateState = Record<CliAutoUpdateAdapterId, CliAutoUpdateStatus>

export function isCliAutoUpdateAdapterId(value: string): value is CliAutoUpdateAdapterId {
  return (CLI_AUTO_UPDATE_ADAPTER_IDS as readonly string[]).includes(value)
}
