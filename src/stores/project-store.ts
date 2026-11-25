import { create } from "zustand"
import { persist } from "zustand/middleware"
import { replaceEqualDeep } from "@tanstack/react-query"
import { api, apiFor } from "@/lib/api"
import { ApiError } from "@/lib/api-client"
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
  /**
   * The conversation that made this workspace for an external agent it dispatched.
   * The sidebar lists it under that conversation, never at the top.
   */
  originChatId?: number | null
  /** The board task whose agent runs here, when one does (absent in a tree cached before the field existed). */
  task?: WorkspaceTask
  /** Its directory no longer exists (deleted outside operon): there is nothing to ask git about. */
  missing?: true
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

/**
 * A board sub-task's session, nested under its parent task's session in the
 * tree — mirrors the server's TaskChildSession. Spec tickets are not listed.
 */
export interface TaskChildSession {
  taskId: number
  number: number
  title: string
  status: string
  parentChatId: number
  chatId: number
  workspaceId: number | null
  providerId: string | null
  modelId: string | null
  effort?: string
  updatedAt: number
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
  /** Board sub-tasks running in sessions of their own, nested under their parent task's session. */
  taskChildren?: TaskChildSession[]
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

/** One other machine's tree, as the sidebar shows it under that machine's heading. */
export interface RemoteProjectTree {
  projects: Project[]
  /** Set while the machine can't be reached; `projects` then holds the last tree seen. */
  error: string | null
  /**
   * With `error`: whether it may pass by itself (the machine asleep, a network
   * blip, Broker timing out) and is worth trying again on a timer. A refusal —
   * no delegation key, receiving turned off, an older version — is not.
   */
  retryable?: boolean
  /**
   * With `error`, web only: the machine wants this browser paired with it first.
   * The browser reaches every machine itself, with its own key for each.
   */
  needsPairing?: boolean
  loaded: boolean
}

/** The machine refused this browser: it wants a paired device, or the key it holds was dropped. */
export function isPairingRequiredError(error: unknown): boolean {
  return error instanceof ApiError
    && (error.code === "e2ee_required" || error.code === "e2ee_device_untrusted" || error.code === "e2ee_key_invalid")
}

/** A failed remote request that may succeed later without anyone changing anything. */
export function isTransientRemoteError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true
  return error.status >= 500 || error.code === "node_offline" || error.code === "node_unreachable"
}

interface ProjectStore {
  /** This machine's projects. */
  projects: Project[]
  activeProjectId: number | null
  activeWorkspaceId: number | null
  /**
   * The machine the active workspace (and `activeProjectId`) belongs to; null
   * for this one. Ids are only unique per machine, so the pair is what names a
   * workspace. Not persisted: a launch starts on this machine.
   */
  activeNodeId: string | null
  /** Other machines' trees, by node id. In memory only, refetched while shown. */
  remoteProjects: Record<string, RemoteProjectTree>
  /** Local sidebar preference; omitted ids stay expanded. */
  collapsedProjectIds: number[]
  /** Local sidebar preference: workspaces whose conversations are folded away. */
  collapsedWorkspaceIds: number[]
  /**
   * The same preferences for other machines' trees, as {@link remoteFoldKey}s:
   * their ids are only unique per machine. Kept across launches; a machine's
   * keys are pruned when its tree loads.
   */
  collapsedRemoteKeys: string[]
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
  /** Fetch another machine's tree (through this machine's relay). Never throws. */
  loadRemoteProjects: (nodeId: string) => Promise<void>
  /** Forget a machine that left the list. */
  dropRemoteProjects: (nodeId: string) => void
  /** Drop the cached tree and selection. For switching to another backend node. */
  resetProjects: () => void
  addProject: (input: { name: string; rootPath: string; workspaces: Omit<Workspace, "id">[] }) => Promise<Project>
  removeProject: (id: number) => Promise<void>
  /** Pin to / unpin from the top of the list. Moves it at once; puts it back if the server refuses. */
  setProjectPinned: (id: number, pinned: boolean) => Promise<void>
  setProjectCollapsed: (id: number, collapsed: boolean) => void
  setWorkspaceCollapsed: (id: number, collapsed: boolean) => void
  setRemoteCollapsed: (key: string, collapsed: boolean) => void
  setSpecHidden: (taskId: number, hidden: boolean) => void
  setWorkspaceTaskArchived: (taskId: number, archivedAt: number | null) => void
  setActiveProject: (id: number | null) => void
  /** `nodeId`: the workspace is on another machine (absent: this one). */
  setActiveWorkspace: (id: number | null, projectId?: number | null, nodeId?: string | null) => void
  addWorkspace: (projectId: number, workspace: Omit<Workspace, "id">) => Promise<Workspace>
  removeWorkspace: (projectId: number, workspaceId: number) => Promise<void>
  setProjectWorkspaces: (projectId: number, workspaces: Workspace[]) => void
  setWorkspaceDiffStats: (stats: Record<string, WorkspaceDiffStat>) => void

  // Getters
  getActiveProject: () => Project | null
  getActiveWorkspace: () => Workspace | null
}

const NO_PROJECTS: Project[] = []

/** A fold preference in another machine's tree: the machine group, a project or a workspace. */
export function remoteFoldKey(kind: "machine" | "project" | "workspace", nodeId: string, id?: number): string {
  return kind === "machine" ? `m:${nodeId}` : `${kind === "project" ? "p" : "w"}:${nodeId}:${id}`
}

/** Drop one machine's project / workspace keys its fresh tree no longer has. Same array when nothing goes. */
export function pruneRemoteFoldKeys(keys: string[], nodeId: string, projects: Project[]): string[] {
  const live = new Set<string>()
  for (const project of projects) {
    live.add(remoteFoldKey("project", nodeId, project.id))
    for (const workspace of project.workspaces) live.add(remoteFoldKey("workspace", nodeId, workspace.id))
  }
  const ownPrefixes = [`p:${nodeId}:`, `w:${nodeId}:`]
  const next = keys.filter((key) => !ownPrefixes.some((prefix) => key.startsWith(prefix)) || live.has(key))
  return next.length === keys.length ? keys : next
}

/** The project tree of one machine (`nodeId` null / undefined: this one). */
export function projectsOn(
  state: Pick<ProjectStore, "projects" | "remoteProjects">,
  nodeId: string | null | undefined,
): Project[] {
  return nodeId ? state.remoteProjects[nodeId]?.projects ?? NO_PROJECTS : state.projects
}

/** A workspace by id on one machine's tree. */
export function findWorkspaceOn(
  state: Pick<ProjectStore, "projects" | "remoteProjects">,
  nodeId: string | null | undefined,
  workspaceId: number | null | undefined,
): Workspace | undefined {
  if (workspaceId == null) return undefined
  for (const project of projectsOn(state, nodeId)) {
    const workspace = project.workspaces.find((w) => w.id === workspaceId)
    if (workspace) return workspace
  }
  return undefined
}

export const useProjectStore = create<ProjectStore>()(
  persist(
    (set, get) => ({
      projects: [],
      activeProjectId: null,
      activeWorkspaceId: null,
      activeNodeId: null,
      remoteProjects: {},
      collapsedProjectIds: [],
      collapsedWorkspaceIds: [],
      collapsedRemoteKeys: [],
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
          activeNodeId: null,
          remoteProjects: {},
          collapsedProjectIds: [],
          collapsedWorkspaceIds: [],
          collapsedRemoteKeys: [],
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
          // The selection is another machine's: this tree has nothing to say about it.
          const selectionElsewhere = state.activeNodeId != null
          const hasActiveProject =
            selectionElsewhere ||
            state.activeProjectId !== null &&
            fullProjects.some((project) => project.id === state.activeProjectId)
          const hasActiveWorkspace =
            selectionElsewhere ||
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

          // Keep the array reference when nothing was dropped: ProjectItem
          // subscribes to collapsedWorkspaceIds whole, and a fresh-but-equal
          // array re-renders every project row on each tree refresh.
          const collapsedProjectIds = state.collapsedProjectIds.filter((id) =>
            fullProjects.some((project) => project.id === id)
          )
          const collapsedWorkspaceIds = state.collapsedWorkspaceIds.filter((id) =>
            fullProjects.some((project) => project.workspaces.some((workspace) => workspace.id === id))
          )
          return {
            // A live task refresh must not replace unchanged projects or rows.
            projects: replaceEqualDeep(state.projects, fullProjects),
            collapsedProjectIds: collapsedProjectIds.length === state.collapsedProjectIds.length
              ? state.collapsedProjectIds
              : collapsedProjectIds,
            collapsedWorkspaceIds: collapsedWorkspaceIds.length === state.collapsedWorkspaceIds.length
              ? state.collapsedWorkspaceIds
              : collapsedWorkspaceIds,
            activeProjectId: nextActiveProjectId,
            activeWorkspaceId: nextActiveWorkspaceId,
            projectsLoaded: true,
            cacheNodeId: currentCacheNodeId(),
          }
        })
      },

      loadRemoteProjects: async (nodeId) => {
        try {
          const { projects } = await apiFor(nodeId).projectListWithWorkspaces()
          const fresh = projects.map(({ workspaces, ...project }) => ({ ...project, workspaces }))
          set((state) => ({
            collapsedRemoteKeys: pruneRemoteFoldKeys(state.collapsedRemoteKeys, nodeId, fresh),
            remoteProjects: {
              ...state.remoteProjects,
              [nodeId]: {
                projects: replaceEqualDeep(state.remoteProjects[nodeId]?.projects ?? [], fresh),
                error: null,
                loaded: true,
              },
            },
          }))
        } catch (error) {
          set((state) => ({
            remoteProjects: {
              ...state.remoteProjects,
              [nodeId]: {
                projects: state.remoteProjects[nodeId]?.projects ?? [],
                error: error instanceof Error ? error.message : String(error),
                retryable: isTransientRemoteError(error),
                needsPairing: __APP_TARGET__ === "web" && isPairingRequiredError(error),
                loaded: true,
              },
            },
          }))
        }
      },

      dropRemoteProjects: (nodeId) => {
        set((state) => {
          if (!(nodeId in state.remoteProjects)) return state
          const remoteProjects = { ...state.remoteProjects }
          delete remoteProjects[nodeId]
          return { remoteProjects }
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
          activeNodeId: null,
        }))
        trackEvent('project_added', { workspace_count: workspaces.length })
        return fullProject
      },

      removeProject: async (id) => {
        await api.projectDelete(id)
        set((state) => ({
          projects: state.projects.filter((p) => p.id !== id),
          collapsedProjectIds: state.collapsedProjectIds.filter((projectId) => projectId !== id),
          activeProjectId: state.activeNodeId == null && state.activeProjectId === id ? null : state.activeProjectId,
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

      setWorkspaceCollapsed: (id, collapsed) => {
        set((state) => ({
          collapsedWorkspaceIds: collapsed
            ? state.collapsedWorkspaceIds.includes(id)
              ? state.collapsedWorkspaceIds
              : [...state.collapsedWorkspaceIds, id]
            : state.collapsedWorkspaceIds.filter((workspaceId) => workspaceId !== id),
        }))
      },

      setRemoteCollapsed: (key, collapsed) => {
        set((state) => {
          const has = state.collapsedRemoteKeys.includes(key)
          if (has === collapsed) return state
          return {
            collapsedRemoteKeys: collapsed
              ? [...state.collapsedRemoteKeys, key]
              : state.collapsedRemoteKeys.filter((k) => k !== key),
          }
        })
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
          activeNodeId: null,
        })
      },

      setActiveWorkspace: (id, projectId, nodeId) => {
        set((state) => {
          const activeNodeId = nodeId ?? null
          return {
            activeWorkspaceId: id,
            // A project id from the other machine's tree means nothing here, so
            // switching machine without one clears it rather than keeping it.
            activeProjectId: projectId ?? (activeNodeId === state.activeNodeId ? state.activeProjectId : null),
            activeNodeId,
          }
        })
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
          activeWorkspaceId: state.activeNodeId == null && state.activeWorkspaceId === workspaceId ? null : state.activeWorkspaceId,
        }))
      },

      setProjectWorkspaces: (projectId, workspaces) => {
        set((state) => {
          const isActiveProject = state.activeNodeId == null && state.activeProjectId === projectId
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
        set((state) => {
          // Refreshed on every turn start/end and window focus, almost always with
          // the same numbers: keep the existing object then, so the sidebar that
          // reads it doesn't re-render for nothing.
          let next: Record<string, WorkspaceDiffStat> | null = null
          for (const [path, stat] of Object.entries(stats)) {
            const current = state.workspaceDiffStats[path]
            if (current && current.additions === stat.additions && current.deletions === stat.deletions) continue
            next ??= { ...state.workspaceDiffStats }
            next[path] = stat
          }
          return next ? { workspaceDiffStats: next } : state
        })
      },

      getActiveProject: () => {
        const state = get()
        return projectsOn(state, state.activeNodeId).find((p) => p.id === state.activeProjectId) || null
      },

      getActiveWorkspace: () => {
        const state = get()
        if (!state.activeWorkspaceId) return null
        for (const project of projectsOn(state, state.activeNodeId)) {
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
        collapsedWorkspaceIds: state.collapsedWorkspaceIds,
        collapsedRemoteKeys: state.collapsedRemoteKeys,
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
          collapsedWorkspaceIds: stale ? [] : saved.collapsedWorkspaceIds ?? [],
          collapsedRemoteKeys: stale ? [] : saved.collapsedRemoteKeys ?? [],
          hiddenSpecIds: stale ? [] : saved.hiddenSpecIds ?? [],
          shownSpecIds: stale ? [] : saved.shownSpecIds ?? [],
        }
      },
    }
  )
)
