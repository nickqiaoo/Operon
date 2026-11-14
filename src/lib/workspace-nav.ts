import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore, type Workspace } from '@/stores/project-store'

/** The workspace and its project in the sidebar's tree, when the tree has it. */
export function findWorkspace(workspaceId: number): { workspace: Workspace; projectId: number } | undefined {
  for (const project of useProjectStore.getState().projects) {
    const workspace = project.workspaces.find((w) => w.id === workspaceId)
    if (workspace) return { workspace, projectId: project.id }
  }
  return undefined
}

const reloadedFor = new Set<number>()
/** One reload at a time: a snapshot naming several new workspaces asks for the tree once. */
let reloading: Promise<void> | null = null

function reloadTree(): Promise<void> {
  reloading ??= useProjectStore.getState().loadProjects().finally(() => { reloading = null })
  return reloading
}

/**
 * A workspace the server just made (an agent's `workspace_create`, or an external agent
 * started in one) is not in the cached tree yet: reload it once, so it shows in the
 * sidebar and can be opened. Once per id, so a workspace that stays unknown (deleted)
 * does not reload on every frame that names it. Before the tree's first load there is
 * nothing to do: that load brings it.
 *
 * `force` waits for the tree even before its first load, for a caller about to open it.
 */
export async function ensureWorkspaceKnown(workspaceId: number, force = false): Promise<void> {
  if (findWorkspace(workspaceId) || reloadedFor.has(workspaceId)) return
  if (!force && !useProjectStore.getState().projectsLoaded) return
  reloadedFor.add(workspaceId)
  try {
    await reloadTree()
  } catch {
    reloadedFor.delete(workspaceId)
  }
}

/** Make `workspaceId` the current workspace, loading the tree first when it doesn't have it. False when there is no such workspace. */
export async function activateWorkspace(workspaceId: number): Promise<boolean> {
  await ensureWorkspaceKnown(workspaceId, true)
  const found = findWorkspace(workspaceId)
  if (!found) return false
  useProjectStore.getState().setActiveWorkspace(workspaceId, found.projectId)
  useNavigationStore.getState().showWorkbench()
  return true
}
