import { create } from "zustand"
import { persist } from "zustand/middleware"
import { api } from "@/lib/api"
import { trackEvent } from "@/lib/analytics"
import { getSelectedNodeId } from "@/lib/web-auth"

/**
 * Which backend the cached tree came from. Always null on desktop (one local
 * backend); on web it is the selected node, because the same localStorage
 * serves every machine the user can tunnel into and their project ids overlap.
 */
const currentCacheNodeId = (): string | null =>
  __APP_TARGET__ === "web" ? getSelectedNodeId() : null

export interface Workspace {
  id: number
  name: string
  branchName: string
  worktreePath: string
  /** The board task whose agent runs here, when one does (absent in a tree cached before the field existed). */
  task?: WorkspaceTask
}

/** A dispatched task, a spec, or one of a spec's tickets — mirrors the server's WorkspaceTask. */
export interface WorkspaceTask {
  id: number
  number: number
  title: string
  status: string
  /** Set on a spec's ticket: the spec it belongs to. */
  parentTaskId: number | null
  /** Set on a spec. */
  specStage: string | null
  archivedAt?: number | null
  /** Provider of the task's current conversation, falling back to its assigned agent. */
  providerId?: string | null
  /** A spec's conversation — the chat it was started from, where the user talks to it. */
  sourceChat?: WorkspaceChat | null
  /** A spec's coordinator session — its working log. */
  coordinatorChat?: WorkspaceChat | null
  /** A spec's tickets whose worktree is gone (landed or dropped); their sessions still open. */
  finishedTickets?: Array<{ id: number; number: number; title: string; status: string; chat: WorkspaceChat }>
}

/** A conversation the sidebar opens, in its own workspace (or the spec's, once that is gone). */
export interface WorkspaceChat {
  providerId?: string | null
  chatId: number
  workspaceId: number | null
  title: string
}

export type WorkspaceDiffStat = { additions: number; deletions: number }

export interface Project {
  id: number
  name: string
  rootPath: string
  workspaces: Workspace[]
  /** Specs remain available after their workspaces have been reclaimed. */
  specs?: WorkspaceTask[]
  createdAt: number
  updatedAt: number
  /**
   * When the user pinned it to the top of the sidebar; null / absent when not
   * pinned. Optional: a tree cached before the field existed has none.
   */
  pinnedAt?: number | null
}

/**
 * The sidebar's order, same as the server's: pinned first in the order they
 * were pinned, then the rest newest first. Used where the store changes the
 * list itself (pin, add) instead of reloading it.
 */
export function sortProjects(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => {
    const pa = a.pinnedAt ?? null
    const pb = b.pinnedAt ?? null
    if (pa != null && pb != null) return pa - pb
    if (pa != null) return -1
    if (pb != null) return 1
    return b.updatedAt - a.updatedAt
  })
}

interface ProjectStore {
  projects: Project[]
  activeProjectId: number | null
  activeWorkspaceId: number | null
  /** Local sidebar preference; omitted ids stay expanded. */
  collapsedProjectIds: number[]
  /** Local display preference, independent of task status and archiving. */
  hiddenSpecIds: number[]
  /** Explicitly shown specs can appear even without a workspace. */
  shownSpecIds: number[]
  /**
   * Whether `loadProjects` has settled at least once this session. `projects`
   * is persisted, so an empty list on its own can't tell "no projects" apart
   * from "still fetching" — the sidebar needs this to choose between a skeleton
   * and the empty state instead of flashing "No projects yet" on every web load.
   */
  projectsLoaded: boolean
  /** Node the persisted `projects` belong to — see {@link currentCacheNodeId}. */
  cacheNodeId: string | null
  workspaceDiffStats: Record<string, WorkspaceDiffStat>

  // Actions
  loadProjects: () => Promise<void>
  /** Drop the cached tree and selection. For switching to another backend node. */
  resetProjects: () => void
  addProject: (input: { name: string; rootPath: string; workspaces: Omit<Workspace, "id">[] }) => Promise<Project>
  removeProject: (id: number) => Promise<void>
  /** Pin to / unpin from the top of the list. Moves it at once; puts it back if the server refuses. */
  setProjectPinned: (id: number, pinned: boolean) => Promise<void>
  setProjectCollapsed: (id: number, collapsed: boolean) => void
  setSpecHidden: (taskId: number, hidden: boolean) => void
  setWorkspaceTaskArchived: (taskId: number, archivedAt: number | null) => void
  setActiveProject: (id: number | null) => void
  setActiveWorkspace: (id: number | null, projectId?: number | null) => void
  addWorkspace: (projectId: number, workspace: Omit<Workspace, "id">) => Promise<Workspace>
  removeWorkspace: (projectId: number, workspaceId: number) => Promise<void>
  setProjectWorkspaces: (projectId: number, workspaces: Workspace[]) => void
  setWorkspaceDiffStats: (stats: Record<string, WorkspaceDiffStat>) => void

  // Getters
  getActiveProject: () => Project | null
  getActiveWorkspace: () => Workspace | null
}

export const useProjectStore = create<ProjectStore>()(
  persist(
    (set, get) => ({
      projects: [],
      activeProjectId: null,
      activeWorkspaceId: null,
      collapsedProjectIds: [],
      hiddenSpecIds: [],
      shownSpecIds: [],
      projectsLoaded: false,
      cacheNodeId: null,
      workspaceDiffStats: {},

      resetProjects: () => {
        set({
          projects: [],
          activeProjectId: null,
          activeWorkspaceId: null,
          collapsedProjectIds: [],
          hiddenSpecIds: [],
          shownSpecIds: [],
          projectsLoaded: false,
          cacheNodeId: null,
          workspaceDiffStats: {},
        })
      },

      loadProjects: async () => {
        // One request for the whole tree. This used to be `projectList()` plus a
        // `workspaceList()` per project — two serial network hops, and on web
        // each one crosses the broker tunnel.
        let fullProjects: Project[]
        try {
          const { projects } = await api.projectListWithWorkspaces()
          fullProjects = projects.map(({ workspaces, ...project }) => ({ ...project, workspaces }))
        } catch (error) {
          // Let the sidebar leave its skeleton and show whatever is cached;
          // the caller still gets the failure.
          set({ projectsLoaded: true })
          throw error
        }
        set((state) => {
          const hasActiveProject =
            state.activeProjectId !== null &&
            fullProjects.some((project) => project.id === state.activeProjectId)
          const hasActiveWorkspace =
            state.activeWorkspaceId !== null &&
            fullProjects.some((project) =>
              project.workspaces.some((workspace) => workspace.id === state.activeWorkspaceId)
            )

          const fallbackProject = fullProjects[0] ?? null
          const nextActiveProjectId = hasActiveProject
            ? state.activeProjectId
            : fallbackProject?.id ?? null

          const activeProject = nextActiveProjectId === null
            ? null
            : fullProjects.find((project) => project.id === nextActiveProjectId) ?? null

          const nextActiveWorkspaceId = hasActiveWorkspace
            ? state.activeWorkspaceId
            : activeProject?.workspaces[0]?.id ?? null

          return {
            projects: fullProjects,
            collapsedProjectIds: state.collapsedProjectIds.filter((id) =>
              fullProjects.some((project) => project.id === id)
            ),
            activeProjectId: nextActiveProjectId,
            activeWorkspaceId: nextActiveWorkspaceId,
            projectsLoaded: true,
            cacheNodeId: currentCacheNodeId(),
          }
        })
      },

      addProject: async (input) => {
        const { project } = await api.projectCreate({ name: input.name, rootPath: input.rootPath })
        const workspaces: Workspace[] = []
        for (const ws of input.workspaces) {
          const { workspace } = await api.workspaceCreate(project.id, ws)
          workspaces.push(workspace)
        }
        const fullProject: Project = { ...project, workspaces }
        set((state) => ({
          projects: sortProjects([...state.projects, fullProject]),
          activeProjectId: fullProject.id,
          activeWorkspaceId: workspaces[0]?.id ?? null,
        }))
        trackEvent('project_added', { workspace_count: workspaces.length })
        return fullProject
      },

      removeProject: async (id) => {
        await api.projectDelete(id)
        set((state) => ({
          projects: state.projects.filter((p) => p.id !== id),
          collapsedProjectIds: state.collapsedProjectIds.filter((projectId) => projectId !== id),
          activeProjectId: state.activeProjectId === id ? null : state.activeProjectId,
        }))
      },

      setProjectPinned: async (id, pinned) => {
        const before = get().projects.find((p) => p.id === id)
        if (!before) return
        const patch = (pinnedAt: number | null | undefined) =>
          set((state) => ({
            projects: sortProjects(state.projects.map((p) => (p.id === id ? { ...p, pinnedAt } : p))),
          }))
        patch(pinned ? before.pinnedAt ?? Date.now() : null)
        try {
          const { project } = await api.projectSetPinned(id, pinned)
          patch(project.pinnedAt)
        } catch (error) {
          patch(before.pinnedAt)
          throw error
        }
      },

      setProjectCollapsed: (id, collapsed) => {
        set((state) => ({
          collapsedProjectIds: collapsed
            ? state.collapsedProjectIds.includes(id)
              ? state.collapsedProjectIds
              : [...state.collapsedProjectIds, id]
            : state.collapsedProjectIds.filter((projectId) => projectId !== id),
        }))
      },

      setSpecHidden: (taskId, hidden) => {
        set((state) => ({
          hiddenSpecIds: hidden
            ? state.hiddenSpecIds.includes(taskId) ? state.hiddenSpecIds : [...state.hiddenSpecIds, taskId]
            : state.hiddenSpecIds.filter((id) => id !== taskId),
          shownSpecIds: hidden
            ? state.shownSpecIds.filter((id) => id !== taskId)
            : state.shownSpecIds.includes(taskId) ? state.shownSpecIds : [...state.shownSpecIds, taskId],
        }))
      },

      setWorkspaceTaskArchived: (taskId, archivedAt) => {
        const needsUpdate = (task: WorkspaceTask | undefined) => task?.id === taskId && task.archivedAt !== archivedAt
        const owner = get().projects.find((project) =>
          project.workspaces.some((workspace) => needsUpdate(workspace.task)) || project.specs?.some(needsUpdate),
        )
        if (!owner) return
        set((state) => ({
          projects: state.projects.map((project) => project.id === owner.id ? {
            ...project,
            specs: project.specs?.map((spec) => spec.id === taskId ? { ...spec, archivedAt } : spec),
            workspaces: project.workspaces.map((workspace) => workspace.task?.id === taskId
              ? { ...workspace, task: { ...workspace.task, archivedAt } }
              : workspace),
          } : project),
        }))
      },

      setActiveProject: (id) => {
        const project = get().projects.find((p) => p.id === id) || null
        set({
          activeProjectId: id,
          activeWorkspaceId: project?.workspaces[0]?.id ?? null,
        })
      },

      setActiveWorkspace: (id, projectId) => {
        set((state) => ({
          activeWorkspaceId: id,
          activeProjectId: projectId ?? state.activeProjectId
        }))
        trackEvent('workspace_switched', {})
      },

      addWorkspace: async (projectId, workspaceData) => {
        const { workspace } = await api.workspaceCreate(projectId, workspaceData)
        set((state) => ({
          collapsedProjectIds: state.collapsedProjectIds.filter((id) => id !== projectId),
          projects: state.projects.map((p) =>
            p.id === projectId
              ? { ...p, workspaces: [...p.workspaces, workspace], updatedAt: Date.now() }
              : p
          ),
        }))
        return workspace
      },

      removeWorkspace: async (projectId, workspaceId) => {
        await api.workspaceDelete(workspaceId)
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId
              ? { ...p, workspaces: p.workspaces.filter((w) => w.id !== workspaceId) }
              : p
          ),
          activeWorkspaceId: state.activeWorkspaceId === workspaceId ? null : state.activeWorkspaceId,
        }))
      },

      setProjectWorkspaces: (projectId, workspaces) => {
        set((state) => {
          const isActiveProject = state.activeProjectId === projectId
          const hasActiveWorkspace = workspaces.some((w) => w.id === state.activeWorkspaceId)
          return {
            projects: state.projects.map((p) =>
              p.id === projectId
                ? { ...p, workspaces, updatedAt: Date.now() }
                : p
            ),
            activeWorkspaceId: isActiveProject
              ? hasActiveWorkspace
                ? state.activeWorkspaceId
                : workspaces[0]?.id ?? null
              : state.activeWorkspaceId
          }
        })
      },

      setWorkspaceDiffStats: (stats) => {
        set((state) => ({
          workspaceDiffStats: { ...state.workspaceDiffStats, ...stats },
        }))
      },

      getActiveProject: () => {
        const state = get()
        return state.projects.find((p) => p.id === state.activeProjectId) || null
      },

      getActiveWorkspace: () => {
        const state = get()
        if (!state.activeWorkspaceId) return null
        for (const project of state.projects) {
          const workspace = project.workspaces.find((w) => w.id === state.activeWorkspaceId)
          if (workspace) return workspace
        }
        return null
      },
    }),
    {
      name: "operon-projects",
      // The tree itself is cached, not just the selection: `loadProjects` runs
      // on mount and on web it can take a second, during which the sidebar has
      // nothing to draw. Rehydration is synchronous, so the last known tree
      // paints on the first frame and the fetch just corrects it.
      partialize: (state) => ({
        projects: state.projects,
        activeProjectId: state.activeProjectId,
        activeWorkspaceId: state.activeWorkspaceId,
        collapsedProjectIds: state.collapsedProjectIds,
        hiddenSpecIds: state.hiddenSpecIds,
        shownSpecIds: state.shownSpecIds,
        cacheNodeId: state.cacheNodeId,
      }),
      // A cached tree is only valid for the node that produced it. Ids are not
      // comparable across machines, so painting node A's projects while node B
      // loads would be worse than painting nothing. The active ids survive —
      // `loadProjects` already validates them against the fetched tree.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<ProjectStore>
        const stale = (saved.cacheNodeId ?? null) !== currentCacheNodeId()
        return {
          ...current,
          ...saved,
          projects: stale ? [] : saved.projects ?? [],
          collapsedProjectIds: stale ? [] : saved.collapsedProjectIds ?? [],
          hiddenSpecIds: stale ? [] : saved.hiddenSpecIds ?? [],
          shownSpecIds: stale ? [] : saved.shownSpecIds ?? [],
        }
      },
    }
  )
)
