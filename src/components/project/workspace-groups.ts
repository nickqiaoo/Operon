import type { Project, Workspace } from "@/stores/project-store"

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
export function groupSpecWorkspaces(
  workspaces: readonly Workspace[],
  hiddenSpecIds: readonly number[] = [],
): WorkspaceGroups {
  const hiddenSpecs = new Set(hiddenSpecIds)
  for (const workspace of workspaces) {
    if (workspace.task?.specStage != null && workspace.task.archivedAt != null) hiddenSpecs.add(workspace.task.id)
  }
  const specWorkspace = new Map<number, number>()
  for (const w of workspaces) {
    if (w.task?.specStage != null) specWorkspace.set(w.task.id, w.id)
  }
  const top: Workspace[] = []
  const tickets = new Map<number, Workspace[]>()
  for (const w of workspaces) {
    // Hide the whole spec tree, so its tickets do not reappear as loose workspaces.
    if ((w.task?.specStage != null && hiddenSpecs.has(w.task.id)) ||
      (w.task?.parentTaskId != null && hiddenSpecs.has(w.task.parentTaskId))) continue
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

/** Completed specs have no workspace; only explicit user choices appear here. */
export function sidebarSpecShortcuts(project: Project, shownIds: readonly number[], hiddenIds: readonly number[]) {
  return (project.specs ?? []).filter((spec) =>
    shownIds.includes(spec.id) && !hiddenIds.includes(spec.id) && spec.archivedAt == null &&
    !project.workspaces.some((workspace) => workspace.task?.id === spec.id),
  )
}

/** Directory navigation and task navigation have separate identities. */
export function projectSidebarEntries(project: Project, shownIds: readonly number[], hiddenIds: readonly number[]) {
  const specsById = new Map((project.specs ?? []).map((spec) => [spec.id, spec]))
  const withWorkspace = new Set<number>()
  for (const workspace of project.workspaces) {
    if (workspace.task?.specStage != null) {
      specsById.set(workspace.task.id, workspace.task)
      withWorkspace.add(workspace.task.id)
    }
  }
  return {
    workspaces: project.workspaces.filter((workspace) =>
      workspace.task?.archivedAt == null &&
      workspace.task?.specStage == null &&
      (workspace.task?.parentTaskId == null || !specsById.has(workspace.task.parentTaskId)),
    ),
    specs: [...specsById.values()].filter((spec) =>
      !hiddenIds.includes(spec.id) && spec.archivedAt == null &&
      (withWorkspace.has(spec.id) || shownIds.includes(spec.id)),
    ),
  }
}
