import { api } from "@/lib/api"
import { apiOn } from "@/lib/chat-api-context"
import { projectsOn, useProjectStore, type Project, type Workspace } from "@/stores/project-store"

const trimSlash = (p: string) => p.replace(/[\\/]+$/, "")

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
 * A worktree on a fresh branch for a chat's first send, under a placeholder
 * name the server replaces once the chat's messages say what it is for, cut
 * from `base` (the default branch when unset). Returns the synced
 * workspace so a tab can move into it right away. `nodeId`: the project is on
 * another machine; its tree is re-read from there.
 */
export async function createAutoWorkspace(
  project: Project,
  input: { base?: string },
  nodeId?: string,
): Promise<Workspace> {
  const { workspace } = await apiOn(nodeId).workspaceCreateAuto(project.id, input)
  if (nodeId) {
    // Settles either way; on failure the tree keeps its last copy.
    await useProjectStore.getState().loadRemoteProjects(nodeId)
    const synced = projectsOn(useProjectStore.getState(), nodeId).find((p) => p.id === project.id)?.workspaces ?? []
    return findSyncedWorkspace(synced, workspace)
  }
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
