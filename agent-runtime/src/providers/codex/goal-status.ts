import type { CodexGoalStatus } from './sdk/protocol/index.js'

/**
 * Goal-status predicates, decoded from the Codex desktop app (`sp`/`cp`).
 */

/** Stopped but resumable (codex `sp(status) === true`). */
export function isResumableGoalStatus(status: CodexGoalStatus): boolean {
  return status === 'paused' || status === 'blocked' || status === 'usageLimited'
}

/** Terminal — the goal is done and not resumable. */
export function isTerminalGoalStatus(status: CodexGoalStatus): boolean {
  return status === 'budgetLimited' || status === 'complete'
}

/** Only an active goal keeps the pursuit loop running. */
export function isActiveGoalStatus(status: CodexGoalStatus): boolean {
  return status === 'active'
}

/** Pause/resume toggle target (codex `cp`). Returns null for terminal states. */
export function toggleGoalStatus(status: CodexGoalStatus): CodexGoalStatus | null {
  switch (status) {
    case 'active':
      return 'paused'
    case 'paused':
    case 'blocked':
    case 'usageLimited':
      return 'active'
    case 'budgetLimited':
    case 'complete':
      return null
  }
}

/** Map a goal terminal/stop status to an AI-SDK finish reason. */
export function goalStatusToFinishReason(status: CodexGoalStatus | undefined): string {
  switch (status) {
    case 'complete':
      return 'stop'
    case 'budgetLimited':
    case 'usageLimited':
      return 'length'
    default:
      return 'stop'
  }
}

/** Debounce before re-issuing goal/set active to continue (codex `My`). */
export const GOAL_CONTINUE_DELAY_MS = 250
