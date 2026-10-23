import { describe, expect, it } from "vitest"
import type { Project, Workspace } from "@/stores/project-store"
import { groupSpecWorkspaces, sidebarSpecShortcuts, projectSidebarEntries } from "./workspace-groups"

const ws = (id: number, task?: Workspace["task"]): Workspace => ({
  id,
  name: `ws ${id}`,
  branchName: `b${id}`,
  worktreePath: `/w/${id}`,
  ...(task ? { task } : {}),
})
const task = (id: number, number: number, extra: Partial<NonNullable<Workspace["task"]>> = {}) => ({
  id,
  number,
  title: `t${number}`,
  status: "in_progress",
  parentTaskId: null,
  specStage: null,
  ...extra,
})

describe("groupSpecWorkspaces", () => {
  it("puts a spec's ticket worktrees under the spec, in ticket order", () => {
    const main = ws(1)
    const spec = ws(2, task(10, 7, { specStage: "building" }))
    const t9 = ws(3, task(12, 9, { parentTaskId: 10 }))
    const t8 = ws(4, task(11, 8, { parentTaskId: 10 }))
    const plain = ws(5, task(13, 3))
    const { top, tickets } = groupSpecWorkspaces([main, spec, t9, t8, plain])

    expect(top.map((w) => w.id)).toEqual([1, 2, 5])
    expect(tickets.get(2)?.map((w) => w.id)).toEqual([4, 3])
  })

  it("keeps a ticket at the top when its spec has no workspace here", () => {
    const orphan = ws(3, task(12, 9, { parentTaskId: 99 }))
    const { top, tickets } = groupSpecWorkspaces([ws(1), orphan])
    expect(top.map((w) => w.id)).toEqual([1, 3])
    expect(tickets.size).toBe(0)
  })
  it("hides a spec and its tickets while preserving unrelated workspaces", () => {
    const spec = ws(2, task(10, 7, { specStage: "building" }))
    const ticket = ws(3, task(11, 8, { parentTaskId: 10 }))
    const plain = ws(4, task(12, 9))
    const workspaces = [ws(1), spec, ticket, plain]

    const hidden = groupSpecWorkspaces(workspaces, [10])
    expect(hidden.top.map((w) => w.id)).toEqual([1, 4])
    expect(hidden.tickets.size).toBe(0)
    // Showing the spec again brings back the same tree without changing tasks.
    expect(groupSpecWorkspaces(workspaces).tickets.get(2)).toEqual([ticket])
    expect(spec.task?.status).toBe("in_progress")
  })

  it("excludes archived specs on a fresh load and restores them when unarchived", () => {
    const spec = ws(2, task(10, 7, { specStage: "stopped", archivedAt: 100 }))
    const ticket = ws(3, task(11, 8, { parentTaskId: 10 }))
    expect(groupSpecWorkspaces([ws(1), spec, ticket]).top.map((w) => w.id)).toEqual([1])
    expect(groupSpecWorkspaces([ws(1), spec, ticket]).tickets.size).toBe(0)

    const restored = { ...spec, task: { ...spec.task!, archivedAt: null } }
    expect(groupSpecWorkspaces([ws(1), restored, ticket]).top.map((w) => w.id)).toEqual([1, 2])
    // Unarchiving must respect a separate manual hide preference.
    expect(groupSpecWorkspaces([ws(1), restored, ticket], [10]).top.map((w) => w.id)).toEqual([1])
  })

})


describe("completed spec shortcuts", () => {
  it("shows a completed spec without recreating a workspace, only when explicitly requested", () => {
    const done = task(10, 7, { specStage: "done", status: "done" })
    const project: Project = { id: 1, name: "Test", rootPath: "/repo", createdAt: 0, updatedAt: 0, workspaces: [], specs: [done] }
    expect(sidebarSpecShortcuts(project, [], [])).toEqual([])
    expect(sidebarSpecShortcuts(project, [10], [])).toEqual([done])
    expect(sidebarSpecShortcuts(project, [10], [10])).toEqual([])
    expect(sidebarSpecShortcuts({ ...project, specs: [{ ...done, archivedAt: 100 }] }, [10], [])).toEqual([])
    expect(sidebarSpecShortcuts({ ...project, workspaces: [ws(2, done)] }, [10], [])).toEqual([])
    expect(project.workspaces).toEqual([])
  })
})

describe('project navigation', () => {
  const project = (workspaces: Workspace[], specs: NonNullable<Project['specs']> = []): Project => ({
    id: 1, name: 'Test', rootPath: '/repo', createdAt: 0, updatedAt: 0, workspaces, specs,
  })

  it('separates directories from specs and their execution worktrees', () => {
    const spec = task(10, 7, { specStage: 'building' })
    const entries = projectSidebarEntries(project([ws(1), ws(2, spec), ws(3, task(11, 8, { parentTaskId: 10 })), ws(4, task(12, 9))], [spec]), [], [])
    expect(entries.workspaces.map((workspace) => workspace.id)).toEqual([1, 4])
    expect(entries.specs).toEqual([spec])
  })

  it('keeps execution worktrees out of directory navigation after the spec workspace is reclaimed or hidden', () => {
    const spec = task(10, 7, { specStage: 'stopped' })
    const data = project([ws(1), ws(3, task(11, 8, { parentTaskId: 10 }))], [spec])
    expect(projectSidebarEntries(data, [10], []).specs).toEqual([spec])
    const hidden = projectSidebarEntries(data, [10], [10])
    expect(hidden.specs).toEqual([])
    expect(hidden.workspaces.map((workspace) => workspace.id)).toEqual([1])
  })

  it('restores an explicitly shown completed spec without requiring a worktree', () => {
    const spec = task(10, 7, { specStage: 'done', status: 'done' })
    const data = project([ws(1)], [spec])
    expect(projectSidebarEntries(data, [], []).specs).toEqual([])
    expect(projectSidebarEntries(data, [10], []).specs).toEqual([spec])
    expect(projectSidebarEntries(project([ws(1)], [{ ...spec, archivedAt: 100 }]), [10], []).specs).toEqual([])
  })
})
