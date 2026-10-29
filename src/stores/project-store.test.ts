import { beforeEach, describe, expect, it, vi } from "vitest"

const { projectListWithWorkspaces, workspaceList } = vi.hoisted(() => ({
  projectListWithWorkspaces: vi.fn(),
  workspaceList: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  api: { projectListWithWorkspaces, workspaceList },
}))
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }))
vi.mock("@/lib/web-auth", () => ({ getSelectedNodeId: () => null }))

import { useProjectStore } from "./project-store"

const tree = [
  {
    id: 1,
    name: "operon",
    rootPath: "/repo",
    createdAt: 0,
    updatedAt: 0,
    workspaces: [
      { id: 10, projectId: 1, name: "main", branchName: "main", worktreePath: "/repo", createdAt: 0, updatedAt: 0 },
      { id: 11, projectId: 1, name: "feat", branchName: "feat", worktreePath: "/wt/feat", createdAt: 0, updatedAt: 0 },
    ],
  },
]

beforeEach(() => {
  projectListWithWorkspaces.mockReset()
  workspaceList.mockReset()
  useProjectStore.getState().resetProjects()
})

describe("loadProjects", () => {
  it("fetches the whole tree in a single request", async () => {
    projectListWithWorkspaces.mockResolvedValue({ projects: tree })

    await useProjectStore.getState().loadProjects()

    expect(projectListWithWorkspaces).toHaveBeenCalledTimes(1)
    // The 1 + N version is what left the sidebar blank on web; no per-project
    // follow-up may creep back in.
    expect(workspaceList).not.toHaveBeenCalled()

    const state = useProjectStore.getState()
    expect(state.projects.map((p) => p.workspaces.map((w) => w.id))).toEqual([[10, 11]])
    expect(state.activeWorkspaceId).toBe(10)
    expect(state.projectsLoaded).toBe(true)
  })

  it("keeps a still-valid selection instead of resetting it to the first workspace", async () => {
    projectListWithWorkspaces.mockResolvedValue({ projects: tree })
    useProjectStore.setState({ activeProjectId: 1, activeWorkspaceId: 11 })

    await useProjectStore.getState().loadProjects()

    expect(useProjectStore.getState().activeWorkspaceId).toBe(11)
  })

  it("marks the load as settled when it fails, so the sidebar drops its skeleton", async () => {
    projectListWithWorkspaces.mockRejectedValue(new Error("tunnel down"))

    await expect(useProjectStore.getState().loadProjects()).rejects.toThrow("tunnel down")

    expect(useProjectStore.getState().projectsLoaded).toBe(true)
  })

  it("retains the tree reference for an unchanged refresh", async () => {
    projectListWithWorkspaces.mockImplementation(async () => ({ projects: structuredClone(tree) }))
    await useProjectStore.getState().loadProjects()
    const previous = useProjectStore.getState().projects
    await useProjectStore.getState().loadProjects()
    expect(useProjectStore.getState().projects).toBe(previous)
  })

  it("retains unrelated projects and workspace rows when a Spec changes", async () => {
    const spec = { id: 42, number: 1, title: 'Spec', status: 'in_progress', parentTaskId: null, specStage: 'grounding', archivedAt: null }
    const initial = [{ ...tree[0], specs: [spec] }, { ...tree[0], id: 2 }]
    projectListWithWorkspaces.mockResolvedValueOnce({ projects: structuredClone(initial) })
    await useProjectStore.getState().loadProjects()
    const previous = useProjectStore.getState().projects
    projectListWithWorkspaces.mockResolvedValueOnce({ projects: [{ ...initial[0], specs: [{ ...spec, specStage: 'stopped' }] }, initial[1]] })
    await useProjectStore.getState().loadProjects()
    const next = useProjectStore.getState().projects
    expect(next[0]).not.toBe(previous[0])
    expect(next[0].specs?.[0].specStage).toBe('stopped')
    expect(next[0].workspaces).toBe(previous[0].workspaces)
    expect(next[1]).toBe(previous[1])
  })
})


describe("spec sidebar preferences", () => {
  it("keeps a hidden spec hidden across tree refreshes without changing the selection", async () => {
    projectListWithWorkspaces.mockResolvedValue({ projects: tree })
    await useProjectStore.getState().loadProjects()
    useProjectStore.getState().setSpecHidden(42, true)
    useProjectStore.getState().setSpecHidden(42, true)
    await useProjectStore.getState().loadProjects()

    expect(useProjectStore.getState().hiddenSpecIds).toEqual([42])
    expect(useProjectStore.getState().activeWorkspaceId).toBe(10)
    expect(useProjectStore.getState().projects[0].workspaces).toEqual(tree[0].workspaces)
    useProjectStore.getState().setSpecHidden(42, false)
    expect(useProjectStore.getState().hiddenSpecIds).toEqual([])
    expect(useProjectStore.getState().shownSpecIds).toEqual([42])
  })

  it("updates archive visibility without clearing manual hiding or removing workspaces", () => {
    const spec = {
      id: 42, number: 1, title: "Spec", status: "in_progress",
      parentTaskId: null, specStage: "building", archivedAt: null,
    }
    useProjectStore.setState({ projects: [{ ...tree[0], workspaces: [{ ...tree[0].workspaces[1], task: spec }] }] })
    useProjectStore.getState().setSpecHidden(42, true)
    useProjectStore.getState().setWorkspaceTaskArchived(42, 100)
    expect(useProjectStore.getState().projects[0].workspaces[0].task).toEqual({ ...spec, archivedAt: 100 })
    useProjectStore.getState().setWorkspaceTaskArchived(42, null)
    expect(useProjectStore.getState().projects[0].workspaces[0].task).toEqual(spec)
    expect(useProjectStore.getState().hiddenSpecIds).toEqual([42])
    useProjectStore.getState().resetProjects()
    expect(useProjectStore.getState().hiddenSpecIds).toEqual([])
  })
})
