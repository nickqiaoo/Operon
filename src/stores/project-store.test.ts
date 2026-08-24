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
})
