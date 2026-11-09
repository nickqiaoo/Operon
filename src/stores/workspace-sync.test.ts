import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({ api: {} }))
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }))
vi.mock("@/lib/web-auth", () => ({ getSelectedNodeId: () => null }))

import { useAppShellStore } from "./app-shell-store"
import { useEditorStore } from "./editor-store"
import { useProjectStore, type Project } from "./project-store"
import { useTabsStore } from "./tabs-store"
import { bindWorkspaceStores, DESKTOP_WORKSPACE_SYNC, MOBILE_WORKSPACE_SYNC } from "./workspace-sync"

const workspace = (id: number) => ({ id, name: `w${id}`, branchName: `b${id}`, worktreePath: `/w/${id}` })
const project = (id: number, workspaceIds: number[]): Project => ({
  id,
  name: `p${id}`,
  rootPath: `/p/${id}`,
  createdAt: 0,
  updatedAt: 0,
  workspaces: workspaceIds.map(workspace),
})

const WORKSPACE_A = 10
const WORKSPACE_B = 20
const select = (id: number | null, projectId?: number) =>
  useProjectStore.getState().setActiveWorkspace(id, projectId)
const rightPanelOpen = () => useAppShellStore.getState().rightPanelOpen
const bottomPanelOpen = () => useAppShellStore.getState().bottomPanelOpen

let unbind: () => void

beforeEach(() => {
  useProjectStore.setState({
    projects: [project(1, [WORKSPACE_A]), project(2, [WORKSPACE_B])],
    activeProjectId: null,
    activeWorkspaceId: null,
  })
  useEditorStore.setState({
    tabs: [],
    activeTabId: "",
    currentWorkspaceId: null,
    currentProjectId: null,
    workspaceStates: {},
  })
  useTabsStore.setState({ byWorkspace: {}, currentWorkspaceId: null })
  useAppShellStore.setState({
    rightPanelOpen: false,
    bottomPanelOpen: false,
    rightPanelExpanded: false,
    panelsOpenByWorkspace: {},
    panelWorkspaceKey: null,
  })
  unbind = () => {}
})

afterEach(() => unbind())

describe("following the active workspace", () => {
  it("has switched every bucket by the time the write returns", () => {
    unbind = bindWorkspaceStores(DESKTOP_WORKSPACE_SYNC)

    select(WORKSPACE_A, 1)

    expect(useEditorStore.getState()).toMatchObject({ currentWorkspaceId: WORKSPACE_A, currentProjectId: 1 })
    expect(useTabsStore.getState().currentWorkspaceId).toBe(String(WORKSPACE_A))
  })

  it("opens a tab in the destination workspace right after switching", () => {
    unbind = bindWorkspaceStores(DESKTOP_WORKSPACE_SYNC)
    select(WORKSPACE_A, 1)

    select(WORKSPACE_B, 2)
    useEditorStore.getState().openChatTab("chat:1")
    select(WORKSPACE_A, 1)

    expect(useEditorStore.getState().tabs).toEqual([])
    expect(useEditorStore.getState().workspaceStates[WORKSPACE_B].tabs.map((tab) => tab.id)).toEqual(["chat:1"])
  })

  it("follows a change that did not come from setActiveWorkspace", () => {
    unbind = bindWorkspaceStores(DESKTOP_WORKSPACE_SYNC)

    useProjectStore.getState().setActiveProject(2)

    expect(useEditorStore.getState().currentWorkspaceId).toBe(WORKSPACE_B)
  })

  it("picks up the persisted selection when it binds", () => {
    useProjectStore.setState({ activeWorkspaceId: WORKSPACE_A, activeProjectId: 1 })

    unbind = bindWorkspaceStores(DESKTOP_WORKSPACE_SYNC)

    expect(useEditorStore.getState().currentWorkspaceId).toBe(WORKSPACE_A)
  })

  it("stops following once unbound", () => {
    bindWorkspaceStores(DESKTOP_WORKSPACE_SYNC)()

    select(WORKSPACE_A, 1)

    expect(useEditorStore.getState().currentWorkspaceId).toBeNull()
  })

  it("has no current project on desktop without a workspace, but keeps it on the phone", () => {
    unbind = bindWorkspaceStores(DESKTOP_WORKSPACE_SYNC)
    select(null, 1)
    expect(useEditorStore.getState().currentProjectId).toBeNull()
    unbind()

    unbind = bindWorkspaceStores(MOBILE_WORKSPACE_SYNC)
    expect(useEditorStore.getState().currentProjectId).toBe(1)
  })
})

describe("panels per workspace", () => {
  it("remembers the bottom panel independently of the right one", () => {
    unbind = bindWorkspaceStores(DESKTOP_WORKSPACE_SYNC)
    select(WORKSPACE_A, 1)
    useAppShellStore.getState().setBottomPanelOpen(true)

    select(WORKSPACE_B, 2)
    expect(bottomPanelOpen()).toBe(false)
    useAppShellStore.getState().setRightPanelOpen(true)

    select(WORKSPACE_A, 1)
    expect(bottomPanelOpen()).toBe(true)
    expect(rightPanelOpen()).toBe(false)

    select(WORKSPACE_B, 2)
    expect(bottomPanelOpen()).toBe(false)
    expect(rightPanelOpen()).toBe(true)
  })

  it("keeps both persisted states for the workspace the app reopens in", () => {
    useProjectStore.setState({ activeWorkspaceId: WORKSPACE_A, activeProjectId: 1 })
    useAppShellStore.setState({ rightPanelOpen: true, bottomPanelOpen: true })

    unbind = bindWorkspaceStores(DESKTOP_WORKSPACE_SYNC)

    expect(rightPanelOpen()).toBe(true)
    expect(bottomPanelOpen()).toBe(true)
  })

  it("restores what each workspace last had", () => {
    unbind = bindWorkspaceStores(DESKTOP_WORKSPACE_SYNC)
    select(WORKSPACE_A, 1)
    useAppShellStore.getState().setRightPanelOpen(true)

    select(WORKSPACE_B, 2)
    expect(rightPanelOpen()).toBe(false)

    useAppShellStore.getState().setRightPanelOpen(true)
    useAppShellStore.getState().setRightPanelOpen(false)
    select(WORKSPACE_A, 1)
    expect(rightPanelOpen()).toBe(true)

    useAppShellStore.getState().setRightPanelOpen(false)
    select(WORKSPACE_B, 2)
    useAppShellStore.getState().setRightPanelOpen(true)
    select(WORKSPACE_A, 1)
    expect(rightPanelOpen()).toBe(false)

    select(WORKSPACE_B, 2)
    expect(rightPanelOpen()).toBe(true)
  })

  it("keeps the persisted state for the workspace the app reopens in", () => {
    useProjectStore.setState({ activeWorkspaceId: WORKSPACE_A, activeProjectId: 1 })
    useAppShellStore.setState({ rightPanelOpen: true })

    unbind = bindWorkspaceStores(DESKTOP_WORKSPACE_SYNC)

    expect(rightPanelOpen()).toBe(true)
    expect(useAppShellStore.getState().panelWorkspaceKey).toBe(String(WORKSPACE_A))
  })

  it("is left alone by the phone shell", () => {
    useAppShellStore.setState({ rightPanelOpen: true, bottomPanelOpen: true })
    unbind = bindWorkspaceStores(MOBILE_WORKSPACE_SYNC)

    select(WORKSPACE_A, 1)

    expect(rightPanelOpen()).toBe(true)
    expect(bottomPanelOpen()).toBe(true)
    expect(useAppShellStore.getState().panelWorkspaceKey).toBeNull()
  })
})
