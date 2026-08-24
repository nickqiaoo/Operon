import { describe, expect, it } from "vitest"
import { resolveCronjobEditorLocation } from "./cronjobUtils"

const projects = [
  { id: 1, workspaces: [{ id: 11 }, { id: 12 }] },
  { id: 2, workspaces: [{ id: 21 }, { id: 22 }] },
]

describe("resolveCronjobEditorLocation", () => {
  it("uses the edited task workspace instead of the active workspace", () => {
    expect(resolveCronjobEditorLocation({
      projects,
      initialWorkspaceId: 22,
      activeProjectId: 1,
      activeWorkspaceId: 11,
    })).toEqual({ projectId: 2, workspaceId: 22 })
  })

  it("uses the active location when creating a task", () => {
    expect(resolveCronjobEditorLocation({
      projects,
      activeProjectId: 1,
      activeWorkspaceId: 12,
    })).toEqual({ projectId: 1, workspaceId: 12 })
  })

  it("falls back to the active location when the stored workspace is gone", () => {
    expect(resolveCronjobEditorLocation({
      projects,
      initialWorkspaceId: 999,
      activeProjectId: 1,
      activeWorkspaceId: 11,
    })).toEqual({ projectId: 1, workspaceId: 11 })
  })
})
