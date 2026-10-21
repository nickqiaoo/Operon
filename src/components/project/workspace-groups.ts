import type { Workspace } from "@/stores/project-store"

export interface WorkspaceGroups {
  /** What the project lists: every workspace that is not a spec's ticket. */
  top: Workspace[]
  /** A spec's ticket worktrees, by the spec's own workspace id. */
  tickets: Map<number, Workspace[]>
}

/**
 * A spec's ticket worktrees go under the spec's workspace instead of beside it:
 * each holds one agent at work on one ticket and goes away when the ticket
 * merges, so as siblings they would crowd out the workspaces people open
 * themselves. A ticket whose spec has no workspace here stays at the top.
 */
export function groupSpecWorkspaces(workspaces: readonly Workspace[]): WorkspaceGroups {
  const specWorkspace = new Map<number, number>()
  for (const w of workspaces) {
    if (w.task?.specStage != null) specWorkspace.set(w.task.id, w.id)
  }
  const top: Workspace[] = []
  const tickets = new Map<number, Workspace[]>()
  for (const w of workspaces) {
    const parent = w.task?.parentTaskId != null ? specWorkspace.get(w.task.parentTaskId) : undefined
    if (parent == null) {
      top.push(w)
      continue
    }
    const list = tickets.get(parent)
    if (list) list.push(w)
    else tickets.set(parent, [w])
  }
  for (const list of tickets.values()) list.sort((a, b) => (a.task?.number ?? 0) - (b.task?.number ?? 0))
  return { top, tickets }
}
