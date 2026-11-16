import { api } from "@/lib/api"
import { useProjectStore, type Project, type Workspace } from "@/stores/project-store"

const trimSlash = (p: string) => p.replace(/[\\/]+$/, "")

/**
 * New worktree on a new branch, registered as a workspace of `project`. The
 * server places it under operon's managed worktrees dir
 * (~/.operon/worktrees/<id>-<repo>/<name>) and returns the absolute path.
 * Throws when the worktree or the workspace row cannot be created.
 */
export async function createProjectWorkspace(project: Project, branchName: string): Promise<Workspace> {
  const safeBranch = branchName.replace(/[^a-zA-Z0-9._-]+/g, "-")
  const worktreePath = await api.gitWorktreeAdd(
    project.rootPath,
    "",
    branchName,
    true,
    undefined,
    { projectId: project.id, name: safeBranch },
  )
  return useProjectStore.getState().addWorkspace(project.id, {
    name: safeBranch || branchName,
    branchName,
    worktreePath,
  })
}

/** Re-read a project's workspaces from the server (picks up worktrees made outside operon). */
export async function syncProjectWorkspaces(project: Project): Promise<Workspace[]> {
  const result = await api.workspaceList(project.id)
  useProjectStore.getState().setProjectWorkspaces(project.id, result.workspaces)
  return result.workspaces
}

/** The synced copy of `workspace`, matched by path (the id can change on a resync). */
export function findSyncedWorkspace(workspaces: Workspace[], workspace: Workspace): Workspace {
  return workspaces.find((w) => trimSlash(w.worktreePath) === trimSlash(workspace.worktreePath)) ?? workspace
}

/**
 * A worktree on a fresh branch the server names from `hint` (a chat's first
 * message), cut from `base` (the default branch when unset). Returns the synced
 * workspace so a tab can move into it right away.
 */
export async function createAutoWorkspace(project: Project, input: { base?: string; hint?: string }): Promise<Workspace> {
  const { workspace } = await api.workspaceCreateAuto(project.id, input)
  try {
    return findSyncedWorkspace(await syncProjectWorkspaces(project), workspace)
  } catch (error) {
    // The workspace exists; the sidebar picks up the rest on its next load.
    console.warn("[workspace] Failed to sync workspaces:", error)
    return workspace
  }
}

/** The workspace on the project's own checkout (its root folder), else its first one. */
export function mainWorkspaceOf(project: Project): Workspace | undefined {
  const root = trimSlash(project.rootPath)
  return project.workspaces.find((w) => trimSlash(w.worktreePath) === root) ?? project.workspaces[0]
}
