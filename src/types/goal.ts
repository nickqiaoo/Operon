/**
 * Thread-goal types mirrored from the Codex app-server (`thread/goal/*`).
 * Field set + status predicates decoded from Codex desktop (`sp`/`cp`).
 */

export type CodexGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usageLimited'
  | 'budgetLimited'
  | 'complete'

export interface CodexGoal {
  objective: string
  /** Loosely typed: forward whatever status the update event reports. */
  status: CodexGoalStatus | string
  tokenBudget?: number | null
  tokensUsed?: number
  timeUsedSeconds?: number
  threadId?: string
  createdAt?: number
  updatedAt?: number
}

/** Stopped but resumable. */
export function isResumableGoalStatus(status: string): boolean {
  return status === 'paused' || status === 'blocked' || status === 'usageLimited'
}

/** Terminal — done, not resumable. */
export function isTerminalGoalStatus(status: string): boolean {
  return status === 'budgetLimited' || status === 'complete'
}

/** Pause/resume toggle target (null when terminal). */
export function toggleGoalStatus(status: string): 'active' | 'paused' | null {
  switch (status) {
    case 'active':
      return 'paused'
    case 'paused':
    case 'blocked':
    case 'usageLimited':
      return 'active'
    default:
      return null
  }
}
