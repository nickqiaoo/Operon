import { beforeEach, describe, expect, it, vi } from "vitest"

const { projectListWithWorkspaces, workspaceList, remoteProjectList, apiFor } = vi.hoisted(() => {
  const remoteProjectList = vi.fn()
  return {
    projectListWithWorkspaces: vi.fn(),
    workspaceList: vi.fn(),
    remoteProjectList,
    apiFor: vi.fn((nodeId: string) => ({ projectListWithWorkspaces: () => remoteProjectList(nodeId) })),
  }
})

vi.mock("@/lib/api", () => ({
  api: { projectListWithWorkspaces, workspaceList },
  apiFor,
}))
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }))
vi.mock("@/lib/web-auth", () => ({ getSelectedNodeId: () => null }))

import { findWorkspaceOn, projectsOn, pruneRemoteFoldKeys, remoteFoldKey, useProjectStore } from "./project-store"

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
  remoteProjectList.mockReset()
  apiFor.mockClear()
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

// Another machine's tree. Its ids collide with this machine's on purpose: ids
// are only unique per machine.
const NODE = "node-b"
const remoteTree = [
  {
    id: 1,
    name: "laptop-repo",
    rootPath: "/Users/b/repo",
    createdAt: 0,
    updatedAt: 0,
    workspaces: [
      { id: 10, projectId: 1, name: "main", branchName: "main", worktreePath: "/Users/b/repo", createdAt: 0, updatedAt: 0 },
      { id: 12, projectId: 1, name: "fix", branchName: "fix", worktreePath: "/Users/b/wt/fix", createdAt: 0, updatedAt: 0 },
    ],
  },
]

describe("other machines' trees", () => {
  it("loads a machine's tree through its own client and keeps it apart from this one", async () => {
    projectListWithWorkspaces.mockResolvedValue({ projects: tree })
    remoteProjectList.mockResolvedValue({ projects: remoteTree })

    await useProjectStore.getState().loadProjects()
    await useProjectStore.getState().loadRemoteProjects(NODE)

    expect(apiFor).toHaveBeenCalledWith(NODE)
    const state = useProjectStore.getState()
    expect(projectsOn(state, null).map((p) => p.name)).toEqual(["operon"])
    expect(projectsOn(state, NODE).map((p) => p.name)).toEqual(["laptop-repo"])
    expect(projectsOn(state, "unknown")).toEqual([])
    // Same workspace id 10, a different workspace on each machine.
    expect(findWorkspaceOn(state, undefined, 10)?.worktreePath).toBe("/repo")
    expect(findWorkspaceOn(state, NODE, 10)?.worktreePath).toBe("/Users/b/repo")
    expect(findWorkspaceOn(state, NODE, 11)).toBeUndefined()
  })

  it("keeps the last tree and records the error when a machine cannot be reached", async () => {
    remoteProjectList.mockResolvedValueOnce({ projects: remoteTree })
    await useProjectStore.getState().loadRemoteProjects(NODE)
    remoteProjectList.mockRejectedValueOnce(new Error("relay down"))
    await useProjectStore.getState().loadRemoteProjects(NODE)

    const entry = useProjectStore.getState().remoteProjects[NODE]
    expect(entry.error).toBe("relay down")
    expect(entry.loaded).toBe(true)
    expect(entry.projects.map((p) => p.id)).toEqual([1])
  })

  it("forgets a machine that left the list", async () => {
    remoteProjectList.mockResolvedValue({ projects: remoteTree })
    await useProjectStore.getState().loadRemoteProjects(NODE)
    useProjectStore.getState().dropRemoteProjects(NODE)
    expect(useProjectStore.getState().remoteProjects[NODE]).toBeUndefined()
  })
})

describe("active workspace on another machine", () => {
  beforeEach(async () => {
    projectListWithWorkspaces.mockResolvedValue({ projects: tree })
    remoteProjectList.mockResolvedValue({ projects: remoteTree })
    await useProjectStore.getState().loadProjects()
    await useProjectStore.getState().loadRemoteProjects(NODE)
  })

  it("names the machine with the workspace and resolves the active one on that machine", () => {
    useProjectStore.getState().setActiveWorkspace(12, 1, NODE)
    const state = useProjectStore.getState()
    expect(state.activeNodeId).toBe(NODE)
    expect(state.getActiveWorkspace()?.worktreePath).toBe("/Users/b/wt/fix")
    expect(state.getActiveProject()?.name).toBe("laptop-repo")
  })

  it("does not carry a project id across machines", () => {
    useProjectStore.getState().setActiveWorkspace(11, 1)
    useProjectStore.getState().setActiveWorkspace(12, undefined, NODE)
    expect(useProjectStore.getState().activeProjectId).toBeNull()

    // Same machine, no project given: the current project stays.
    useProjectStore.getState().setActiveWorkspace(12, 1, NODE)
    useProjectStore.getState().setActiveWorkspace(10, undefined, NODE)
    expect(useProjectStore.getState().activeProjectId).toBe(1)
  })

  it("comes back to this machine when no machine is given", () => {
    useProjectStore.getState().setActiveWorkspace(12, 1, NODE)
    useProjectStore.getState().setActiveWorkspace(11, 1)
    const state = useProjectStore.getState()
    expect(state.activeNodeId).toBeNull()
    expect(state.getActiveWorkspace()?.worktreePath).toBe("/wt/feat")
  })

  it("keeps a remote selection when this machine's tree refreshes", async () => {
    // Workspace 12 does not exist here; a refresh must not "repair" it to 10.
    useProjectStore.getState().setActiveWorkspace(12, 1, NODE)
    await useProjectStore.getState().loadProjects()
    const state = useProjectStore.getState()
    expect(state.activeNodeId).toBe(NODE)
    expect(state.activeWorkspaceId).toBe(12)
  })
})

describe("folding in other machines' trees", () => {
  const ws = (id: number) => remoteFoldKey("workspace", NODE, id)

  it("keys each fold by machine, so the same ids on two machines fold separately", () => {
    expect(remoteFoldKey("machine", NODE)).toBe("m:node-b")
    expect(remoteFoldKey("project", NODE, 1)).toBe("p:node-b:1")
    expect(remoteFoldKey("workspace", NODE, 10)).toBe("w:node-b:10")
    expect(remoteFoldKey("workspace", "node-c", 10)).not.toBe(ws(10))
  })

  it("folds and unfolds without touching this machine's folds", () => {
    const store = useProjectStore.getState()
    store.setWorkspaceCollapsed(10, true)
    store.setRemoteCollapsed(ws(10), true)
    store.setRemoteCollapsed(ws(10), true)
    expect(useProjectStore.getState().collapsedRemoteKeys).toEqual([ws(10)])
    expect(useProjectStore.getState().collapsedWorkspaceIds).toEqual([10])

    store.setRemoteCollapsed(ws(10), false)
    expect(useProjectStore.getState().collapsedRemoteKeys).toEqual([])
    expect(useProjectStore.getState().collapsedWorkspaceIds).toEqual([10])
  })

  it("prunes a machine's folds its fresh tree no longer has, and only that machine's", async () => {
    const store = useProjectStore.getState()
    for (const key of [remoteFoldKey("machine", NODE), remoteFoldKey("project", NODE, 1), ws(12), ws(99), remoteFoldKey("workspace", "node-c", 99)]) {
      store.setRemoteCollapsed(key, true)
    }
    remoteProjectList.mockResolvedValue({ projects: remoteTree })
    await useProjectStore.getState().loadRemoteProjects(NODE)

    expect(useProjectStore.getState().collapsedRemoteKeys).toEqual([
      "m:node-b",
      "p:node-b:1",
      "w:node-b:12",
      "w:node-c:99",
    ])
  })

  it("keeps the same array when nothing is pruned", () => {
    const keys = [ws(10), remoteFoldKey("machine", NODE)]
    expect(pruneRemoteFoldKeys(keys, NODE, remoteTree)).toBe(keys)
  })

  it("does not prune folds when the tree fails to load", async () => {
    useProjectStore.getState().setRemoteCollapsed(ws(99), true)
    remoteProjectList.mockRejectedValue(new Error("offline"))
    await useProjectStore.getState().loadRemoteProjects(NODE)
    expect(useProjectStore.getState().collapsedRemoteKeys).toEqual([ws(99)])
  })
})
