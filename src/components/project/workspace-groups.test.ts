import { describe, expect, it } from "vitest"
import type { Workspace } from "@/stores/project-store"
import { groupSpecWorkspaces } from "./workspace-groups"

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
})
