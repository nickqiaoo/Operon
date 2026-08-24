/**
 * Team formation for sibling subtasks.
 *
 * A team is the private inbox scope for a group of execution agents: dispatch
 * turns `task.team_id` into the binding's `team_label`, which is how
 * TeamInboxService finds peers (see channel/agent-orchestrator.ts). No team ⇒
 * no peers ⇒ the agent works alone.
 *
 * Two callers, deliberately different policies:
 *  - Epic path (POST /tasks with parentTaskId): a human split the parent by
 *    hand, so every sibling joins one team named after the parent. There is no
 *    machine-readable signal about who needs to coordinate, and the human doing
 *    the splitting can judge it themselves.
 *  - SDD decompose: only subtasks the plan explicitly tagged `[C<n>]` join, one
 *    team per group. The plan author decided this while it had full context,
 *    and a human saw it at the approval gate. Everything else gets no team.
 */
import type { Task } from '../types/task.js'
import type { TaskStorageAdapter } from '../storage/interface.js'

type TeamStorage = Pick<TaskStorageAdapter, 'teamList' | 'teamCreate' | 'taskUpdate'>

/** Find-or-create a team by name within a project (names are unique per project by convention). */
export function ensureTeamNamed(storage: TeamStorage, projectId: number, name: string): number {
  const trimmed = name.trim().slice(0, 60) || 'Team'
  const existing = storage.teamList(projectId).find((t) => t.name === trimmed)
  return (existing ?? storage.teamCreate({ projectId, name: trimmed })).id
}

/**
 * Epic path: the team is pinned on the PARENT so later-added siblings inherit it.
 * Returns the team id plus whether the parent row changed (caller should
 * broadcast it if so).
 */
export function ensureParentTeam(storage: TeamStorage, parent: Task): [number, boolean] {
  if (parent.teamId != null) return [parent.teamId, false]
  const teamId = ensureTeamNamed(
    storage,
    parent.projectId,
    parent.title.trim() || `Task #${parent.number}`,
  )
  storage.taskUpdate(parent.id, { teamId })
  return [teamId, true]
}
