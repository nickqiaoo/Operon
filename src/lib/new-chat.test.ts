import { beforeEach, describe, expect, it, vi } from "vitest"

// The editor and navigation stores are stubbed: what is under test is which
// workspace (on which machine) a new chat lands in, and which machine's agent
// list it reads.
const { createChatTab, setActiveTab, fetchQuery, providersQueryFor, editorTabs } = vi.hoisted(() => ({
  createChatTab: vi.fn(),
  setActiveTab: vi.fn(),
  fetchQuery: vi.fn(),
  providersQueryFor: vi.fn((nodeId: string | undefined) => ({ queryKey: ["providers", nodeId ?? "local"] })),
  editorTabs: [] as unknown[],
}))

vi.mock("@/lib/api", () => ({ api: {}, apiFor: vi.fn() }))
vi.mock("@/lib/chat-api-context", () => ({ apiOn: vi.fn() }))
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }))
vi.mock("@/lib/web-auth", () => ({ getSelectedNodeId: () => null }))
vi.mock("@/lib/chat-drafts", () => ({ getChatDraft: () => "" }))
vi.mock("@/lib/query-client", () => ({ queryClient: { fetchQuery } }))
vi.mock("@/lib/provider-queries", () => ({ providersQueryFor }))
vi.mock("@/stores/editor-store", () => ({
  useEditorStore: { getState: () => ({ tabs: editorTabs, createChatTab, setActiveTab }) },
}))
vi.mock("@/stores/navigation-store", () => ({
  useNavigationStore: { getState: () => ({ pages: [], closePage: vi.fn(), showWorkbench: vi.fn() }) },
}))
vi.mock("@/stores/streaming-store", () => ({
  useStreamingStore: { getState: () => ({ streamingTabIds: new Set<string>() }) },
}))

const { startNewChat, startNewChatInWorkspace } = await import("./new-chat")
const { useProjectStore } = await import("@/stores/project-store")

const NODE = "node-b"
const ws = (id: number, projectId: number, worktreePath: string) => ({
  id, projectId, name: String(id), branchName: String(id), worktreePath, createdAt: 0, updatedAt: 0,
})

// Same project id 1 and overlapping workspace ids on both machines, as in the
// bug `711419cf` fixed: New chat used to read this machine's tree.
const localTree = [{ id: 1, name: "here", rootPath: "/repo", createdAt: 0, updatedAt: 0, workspaces: [ws(10, 1, "/repo"), ws(11, 1, "/wt/a")] }]
const remoteTree = [{ id: 1, name: "there", rootPath: "/b/repo", createdAt: 0, updatedAt: 0, workspaces: [ws(20, 1, "/b/repo"), ws(10, 1, "/b/wt/x")] }]

beforeEach(() => {
  createChatTab.mockReset()
  setActiveTab.mockReset()
  fetchQuery.mockReset().mockResolvedValue([{ id: "codex", available: true }])
  providersQueryFor.mockClear()
  editorTabs.length = 0
  try { localStorage.clear() } catch { /* no storage */ }
  useProjectStore.getState().resetProjects()
  useProjectStore.setState({
    projects: localTree,
    remoteProjects: { [NODE]: { projects: remoteTree, error: null, loaded: true } },
  })
})

describe("startNewChat", () => {
  it("stays on the other machine and goes to that machine's main checkout", async () => {
    // Workspace 10 exists on both machines; on node-b it is a worktree, not the main checkout.
    useProjectStore.getState().setActiveWorkspace(10, 1, NODE)

    await startNewChat()

    const state = useProjectStore.getState()
    expect(state.activeNodeId).toBe(NODE)
    expect(state.activeWorkspaceId).toBe(20)
    expect(providersQueryFor).toHaveBeenCalledWith(NODE)
    expect(createChatTab).toHaveBeenCalledWith("codex", "Chat")
  })

  it("does not switch when the remote main checkout is already current", async () => {
    useProjectStore.getState().setActiveWorkspace(20, 1, NODE)
    const spy = vi.spyOn(useProjectStore.getState(), "setActiveWorkspace")

    await startNewChat()

    expect(spy).not.toHaveBeenCalled()
    expect(useProjectStore.getState().activeNodeId).toBe(NODE)
    spy.mockRestore()
  })

  it("goes to this machine's main checkout when the current workspace is local", async () => {
    useProjectStore.getState().setActiveWorkspace(11, 1)

    await startNewChat()

    const state = useProjectStore.getState()
    expect(state.activeNodeId).toBeNull()
    expect(state.activeWorkspaceId).toBe(10)
    expect(providersQueryFor).toHaveBeenCalledWith(undefined)
  })
})

describe("startNewChatInWorkspace", () => {
  it("switches machine even when the workspace id is the current one", async () => {
    useProjectStore.getState().setActiveWorkspace(10, 1)

    await startNewChatInWorkspace(10, 1, NODE)

    const state = useProjectStore.getState()
    expect(state.activeNodeId).toBe(NODE)
    expect(state.getActiveWorkspace()?.worktreePath).toBe("/b/wt/x")
    expect(providersQueryFor).toHaveBeenCalledWith(NODE)
  })

  it("comes back to this machine for a local workspace with the same id", async () => {
    useProjectStore.getState().setActiveWorkspace(10, 1, NODE)

    await startNewChatInWorkspace(10, 1)

    expect(useProjectStore.getState().activeNodeId).toBeNull()
    expect(useProjectStore.getState().getActiveWorkspace()?.worktreePath).toBe("/repo")
  })
})
