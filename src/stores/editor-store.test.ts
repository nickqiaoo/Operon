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
import { getChatDraft, setChatDraft } from "@/lib/chat-drafts"

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

  it('keeps the original tab and marks a reused Spec agent conversation with its provider and role', () => {
    useEditorStore.setState({ tabs: [chatTab('chat:original-agent', 42)], activeTabId: 'chat:original-agent' })
    const id = useEditorStore.getState().openChatTab('chat:42', 'Spec session', undefined, 'codex', true)
    expect(id).toBe('chat:original-agent')
    expect(useEditorStore.getState().tabs).toEqual([
      expect.objectContaining({ id, chatId: 42, providerId: 'codex', isSubAgent: true, title: 'Conversation' }),
    ])
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

describe("finding an open chat across workspaces", () => {
  it("prefers the current workspace", () => {
    useEditorStore.setState({
      currentWorkspaceId: 1,
      tabs: [chatTab("chat:local-a", 42)],
      workspaceStates: { "2": { tabs: [chatTab("chat:42", 42)], activeTabId: "chat:42" } },
    })

    expect(useEditorStore.getState().findChatTab(42)).toEqual({ workspaceId: 1, tabId: "chat:local-a" })
  })

  it("finds a tab sitting in another workspace or the global bucket", () => {
    useEditorStore.setState({
      currentWorkspaceId: 1,
      tabs: [chatTab("chat:7", 7)],
      workspaceStates: {
        "1": { tabs: [chatTab("chat:42", 42)], activeTabId: "chat:42" },
        "3": { tabs: [chatTab("chat:local-b", 42)], activeTabId: "chat:local-b" },
        global: { tabs: [chatTab("chat:9", 9)], activeTabId: "chat:9" },
      },
    })

    // The current workspace's stale snapshot does not count; the live tabs do.
    expect(useEditorStore.getState().findChatTab(42)).toEqual({ workspaceId: 3, tabId: "chat:local-b" })
    expect(useEditorStore.getState().findChatTab(9)).toEqual({ workspaceId: null, tabId: "chat:9" })
    expect(useEditorStore.getState().findChatTab(100)).toBeUndefined()
  })

  it("skips side chats, which are not editor tabs", () => {
    useEditorStore.setState({ tabs: [{ ...chatTab("chat:42", 42), isSideChat: true }] })

    expect(useEditorStore.getState().findChatTab(42)).toBeUndefined()
  })
})

describe("editor chat session cleanup", () => {
  it("drops the closed tab's draft and preserves drafts in other workspaces", () => {
    useEditorStore.setState({ tabs: [chatTab("chat:draft-one", 1)], currentWorkspaceId: 1 })
    setChatDraft("chat:draft-one", "Workspace one")
    useEditorStore.getState().setWorkspace(2, 7)
    setChatDraft("chat:draft-two", "Workspace two")
    useEditorStore.getState().setWorkspace(1, 7)
    expect(getChatDraft("chat:draft-one")).toBe("Workspace one")

    useEditorStore.getState().closeTab("chat:draft-one")

    expect(getChatDraft("chat:draft-one")).toBe("")
    expect(getChatDraft("chat:draft-two")).toBe("Workspace two")
  })

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

describe("editor tab field updates", () => {
  it("keeps the tabs array when the value is unchanged", () => {
    useEditorStore.setState({ tabs: [chatTab("chat:1", 1), chatTab("chat:2", 2)] })
    const before = useEditorStore.getState().tabs
    const store = useEditorStore.getState()

    store.updateTabTitle("chat:1", "Conversation")
    store.updateTabProviderId("chat:1", "grok")
    store.setTabChatId("chat:2", 2)
    store.updateTabTitle("missing", "Other")

    expect(useEditorStore.getState().tabs).toBe(before)
  })

  it("replaces only the changed tab", () => {
    useEditorStore.setState({ tabs: [chatTab("chat:1", 1), chatTab("chat:2", 2)] })
    const [first, second] = useEditorStore.getState().tabs

    useEditorStore.getState().updateTabTitle("chat:1", "Renamed")

    const [nextFirst, nextSecond] = useEditorStore.getState().tabs
    expect(nextFirst).not.toBe(first)
    expect(nextFirst.title).toBe("Renamed")
    expect(nextSecond).toBe(second)
  })
})
