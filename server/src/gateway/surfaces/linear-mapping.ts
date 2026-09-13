import type { TaskPriority, TaskStatus } from '../../types/task.js'
import type { LinearWorkflowState } from '../../services/integrations/linear-app.js'

// The pure maps between a task and its Linear issue (design.md §11.2). Kept
// free of I/O so they can be tested without the sync machinery.

// ---- priority: operon 0 none, 1 low … 4 urgent; Linear 0 none, 1 urgent … 4 low ----

export function toLinearPriority(p: TaskPriority): number {
  return p === 0 ? 0 : 5 - p
}

export function fromLinearPriority(p: number | null | undefined): TaskPriority {
  if (!p || p < 1 || p > 4) return 0
  return (5 - p) as TaskPriority
}

/** The Linear workflow state a task status maps to (design §11.2 table). */
export function pickLinearState(states: LinearWorkflowState[], status: TaskStatus): LinearWorkflowState | null {
  const byType = (type: string) => states.filter((s) => s.type === type).sort((a, b) => a.position - b.position)
  switch (status) {
    case 'todo':
      return byType('unstarted')[0] ?? byType('backlog')[0] ?? null
    case 'in_progress':
      return byType('started').find((s) => !/review/i.test(s.name)) ?? byType('started')[0] ?? null
    case 'in_review':
      return byType('started').find((s) => /review/i.test(s.name)) ?? null
    case 'done':
      return byType('completed')[0] ?? null
    case 'cancelled':
      return byType('canceled')[0] ?? null
    default:
      return null
  }
}

/** The task status a Linear state means (the reverse map). */
export function statusOfLinearState(state: { type: string; name: string }): TaskStatus | null {
  switch (state.type) {
    case 'backlog':
    case 'unstarted':
    case 'triage':
      return 'todo'
    case 'started':
      return /review/i.test(state.name) ? 'in_review' : 'in_progress'
    case 'completed':
      return 'done'
    case 'canceled':
      return 'cancelled'
    default:
      return null
  }
}

export const REPO_LABEL_PREFIX = 'repo:'
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/

/**
 * The repository an issue names with its `repo:owner/name` label. `none` when
 * no such label, `ambiguous` when several name different repositories,
 * `invalid` when the label is there but is not owner/name.
 */
export function repoFromLabels(labels: string[]): { repo: string } | { error: 'none' | 'ambiguous' | 'invalid'; labels: string[] } {
  const tagged = labels.map((l) => l.trim()).filter((l) => l.toLowerCase().startsWith(REPO_LABEL_PREFIX))
  if (tagged.length === 0) return { error: 'none', labels: [] }
  const names = [...new Set(tagged.map((l) => l.slice(REPO_LABEL_PREFIX.length).trim().toLowerCase()))]
  if (names.length > 1) return { error: 'ambiguous', labels: tagged }
  if (!REPO_NAME.test(names[0])) return { error: 'invalid', labels: tagged }
  return { repo: names[0] }
}
