import { useLayoutEffect } from "react"
import { useAppShellStore } from "./app-shell-store"
import { useEditorStore } from "./editor-store"
import { useProjectStore } from "./project-store"
import { useTabsStore } from "./tabs-store"

type ProjectStoreState = ReturnType<typeof useProjectStore.getState>

export interface WorkspaceSyncOptions {
  /** The project the editor treats as current for this state. */
  projectIdOf: (state: ProjectStoreState) => number | null
  /** Whether the right and bottom panels' open state is remembered per workspace. */
  panelsPerWorkspace: boolean
}

/** The desktop editor only has a current project while a workspace of that project is active. */
export const DESKTOP_WORKSPACE_SYNC: WorkspaceSyncOptions = {
  projectIdOf: (state) =>
    state.projects.find((project) =>
      project.workspaces.some((workspace) => workspace.id === state.activeWorkspaceId)
    )?.id ?? null,
  panelsPerWorkspace: true,
}

/** The phone picks a project without a workspace, and has no side panels to remember. */
export const MOBILE_WORKSPACE_SYNC: WorkspaceSyncOptions = {
  projectIdOf: (state) => state.activeProjectId,
  panelsPerWorkspace: false,
}

/**
 * `useProjectStore` decides which workspace is active; the editor tabs, the
 * panel tabs and the panels' open state each keep a bucket per workspace and
 * follow it.
 *
 * Zustand runs subscribers inside `set`, so by the time `setActiveWorkspace`
 * returns every bucket has switched. Callers can open a tab in the destination
 * workspace on the next line, and no write path (a sidebar click, the fallback
 * in `loadProjects`, a node reset) has to remember to switch the others.
 */
export function bindWorkspaceStores({ projectIdOf, panelsPerWorkspace }: WorkspaceSyncOptions): () => void {
  const sync = (state: ProjectStoreState) => {
    const { activeWorkspaceId } = state
    useTabsStore.getState().setActiveWorkspace(activeWorkspaceId != null ? String(activeWorkspaceId) : null)
    useEditorStore.getState().setWorkspace(activeWorkspaceId, projectIdOf(state))
    if (panelsPerWorkspace) {
      useAppShellStore.getState().switchPanelWorkspace(String(activeWorkspaceId ?? "global"))
    }
  }

  sync(useProjectStore.getState())
  return useProjectStore.subscribe((state, previous) => {
    if (
      state.activeWorkspaceId === previous.activeWorkspaceId &&
      state.activeProjectId === previous.activeProjectId &&
      state.projects === previous.projects
    ) return
    sync(state)
  })
}

/** Layout effect so the shell's passive effects already see the restored workspace. */
export function useWorkspaceStoreSync(options: WorkspaceSyncOptions): void {
  useLayoutEffect(() => bindWorkspaceStores(options), [options])
}
