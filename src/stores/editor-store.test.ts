import { beforeEach, describe, expect, it, vi } from "vitest"

const { aiSessionCleanup } = vi.hoisted(() => ({
  aiSessionCleanup: vi.fn(() => Promise.resolve({ success: true })),
}))

vi.mock("@/lib/api", () => ({
  api: {
    aiSessionCleanup,
  },
}))

vi.mock("@/lib/analytics", () => ({
  trackEvent: vi.fn(),
}))

import { useEditorStore } from "./editor-store"

const chatTab = (id: string, chatId: number) => ({
  id,
  chatId,
  title: "Conversation",
  type: "chat" as const,
  closable: true,
  providerId: "grok",
})

beforeEach(() => {
  aiSessionCleanup.mockClear()
  useEditorStore.setState({
    tabs: [],
    activeTabId: "",
    currentWorkspaceId: null,
    currentProjectId: null,
    workspaceStates: {},
    canvasNavigationRequest: null,
  })
})

describe("editor chat tab identity", () => {
  it("focuses an existing frontend tab when opening the same persisted chat", () => {
    useEditorStore.setState({
      tabs: [chatTab("chat:frontend-id", 42)],
      activeTabId: "chat:other",
    })

    useEditorStore.getState().openChatTab("chat:42", "Inbox notification")

    const state = useEditorStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.activeTabId).toBe("chat:frontend-id")
  })

  it("returns the reused tab id so callers tracking the open tab follow it", () => {
    useEditorStore.setState({
      tabs: [chatTab("chat:frontend-id", 42)],
      activeTabId: "chat:other",
    })

    expect(useEditorStore.getState().openChatTab("chat:42", "History row")).toBe("chat:frontend-id")
  })

  it("returns the new tab id when nothing matches", () => {
    expect(useEditorStore.getState().openChatTab("chat:42", "History row")).toBe("chat:42")
  })

  it("records the persisted chat id when opening a history-style tab id", () => {
    useEditorStore.getState().openChatTab("chat:42", "Inbox notification")

    expect(useEditorStore.getState().tabs[0]?.chatId).toBe(42)
  })

  it("reuses the persisted chat after switching to its workspace", () => {
    useEditorStore.setState({
      tabs: [chatTab("chat:workspace-one", 11)],
      activeTabId: "chat:workspace-one",
      currentWorkspaceId: 1,
      currentProjectId: 7,
      workspaceStates: {
        "2": {
          tabs: [chatTab("chat:workspace-two", 42)],
          activeTabId: "chat:workspace-two",
        },
      },
    })

    useEditorStore.getState().setWorkspace(2, 7)
    useEditorStore.getState().openChatTab("chat:42", "Inbox notification")

    const state = useEditorStore.getState()
    expect(state.currentWorkspaceId).toBe(2)
    expect(state.tabs).toHaveLength(1)
    expect(state.activeTabId).toBe("chat:workspace-two")
  })
})

describe("editor chat session cleanup", () => {
  it("does not clean up a session while another current tab references it", () => {
    useEditorStore.setState({
      tabs: [chatTab("chat:original", 42), chatTab("chat:duplicate", 42)],
      activeTabId: "chat:duplicate",
      currentWorkspaceId: 1,
    })

    useEditorStore.getState().closeTab("chat:duplicate")

    expect(aiSessionCleanup).not.toHaveBeenCalled()
    expect(useEditorStore.getState().tabs.map((tab) => tab.id)).toEqual(["chat:original"])

    useEditorStore.getState().closeTab("chat:original")

    expect(aiSessionCleanup).toHaveBeenCalledOnce()
    expect(aiSessionCleanup).toHaveBeenCalledWith(42)
  })

  it("keeps a session alive while another workspace still references the chat", () => {
    useEditorStore.setState({
      tabs: [chatTab("chat:current", 42)],
      activeTabId: "chat:current",
      currentWorkspaceId: 1,
      workspaceStates: {
        "2": {
          tabs: [chatTab("chat:parked", 42)],
          activeTabId: "chat:parked",
        },
      },
    })

    useEditorStore.getState().closeTab("chat:current")

    expect(aiSessionCleanup).not.toHaveBeenCalled()
  })

  it("ignores the stale current-workspace snapshot when closing the last tab", () => {
    const current = chatTab("chat:current", 42)
    useEditorStore.setState({
      tabs: [current],
      activeTabId: current.id,
      currentWorkspaceId: 1,
      workspaceStates: {
        "1": {
          tabs: [current],
          activeTabId: current.id,
        },
      },
    })

    useEditorStore.getState().closeTab(current.id)

    expect(aiSessionCleanup).toHaveBeenCalledOnce()
    expect(aiSessionCleanup).toHaveBeenCalledWith(42)
  })
})
