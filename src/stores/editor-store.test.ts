import { beforeEach, describe, expect, it, vi } from "vitest"

const { aiSessionCleanup, remoteSessionCleanup, apiFor } = vi.hoisted(() => {
  const remoteSessionCleanup = vi.fn((_nodeId: string, _chatId: number) => Promise.resolve({ success: true }))
  return {
    aiSessionCleanup: vi.fn(() => Promise.resolve({ success: true })),
    remoteSessionCleanup,
    apiFor: vi.fn((nodeId: string) => ({ aiSessionCleanup: (chatId: number) => remoteSessionCleanup(nodeId, chatId) })),
  }
})

vi.mock("@/lib/api", () => ({
  api: {
    aiSessionCleanup,
  },
  apiFor,
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
  remoteSessionCleanup.mockClear()
  useEditorStore.setState({
    tabs: [],
    activeTabId: "",
    currentWorkspaceId: null,
    currentProjectId: null,
    currentNodeId: null,
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

    expect(useEditorStore.getState().findChatTab({ chatId: 42 })).toEqual({ workspaceId: 1, tabId: "chat:local-a" })
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
    expect(useEditorStore.getState().findChatTab({ chatId: 42 })).toEqual({ workspaceId: 3, tabId: "chat:local-b" })
    expect(useEditorStore.getState().findChatTab({ chatId: 9 })).toEqual({ workspaceId: null, tabId: "chat:9" })
    expect(useEditorStore.getState().findChatTab({ chatId: 100 })).toBeUndefined()
  })

  it("skips side chats, which are not editor tabs", () => {
    useEditorStore.setState({ tabs: [{ ...chatTab("chat:42", 42), isSideChat: true }] })

    expect(useEditorStore.getState().findChatTab({ chatId: 42 })).toBeUndefined()
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

describe("draft chats", () => {
  const draftTab = (id: string) => ({
    id,
    title: "Chat",
    type: "chat" as const,
    closable: true,
    providerId: "claude-code",
  })

  it("switches the agent of an unsent chat and bumps its mount revision", () => {
    useEditorStore.setState({ tabs: [draftTab("chat:draft")], activeTabId: "chat:draft" })

    useEditorStore.getState().switchDraftProvider("chat:draft", "codex")

    const tab = useEditorStore.getState().tabs[0]
    expect(tab.providerId).toBe("codex")
    expect(tab.mountRev).toBe(1)
  })

  it("never switches the agent of a chat that was already sent", () => {
    useEditorStore.setState({ tabs: [chatTab("chat:sent", 7)], activeTabId: "chat:sent" })

    useEditorStore.getState().switchDraftProvider("chat:sent", "codex")

    const tab = useEditorStore.getState().tabs[0]
    expect(tab.providerId).toBe("grok")
    expect(tab.mountRev).toBeUndefined()
  })

  it("moves a tab into another workspace, where it becomes active once that workspace loads", () => {
    useEditorStore.setState({
      tabs: [chatTab("chat:keep", 1), draftTab("chat:draft")],
      activeTabId: "chat:draft",
      currentWorkspaceId: 1,
      currentProjectId: 10,
      workspaceStates: { "2": { tabs: [chatTab("chat:other", 2)], activeTabId: "chat:other" } },
    })

    useEditorStore.getState().moveTabToWorkspace("chat:draft", 2)
    let state = useEditorStore.getState()
    expect(state.tabs.map((t) => t.id)).toEqual(["chat:keep"])
    expect(state.activeTabId).toBe("chat:keep")

    useEditorStore.getState().setWorkspace(2, 10)
    state = useEditorStore.getState()
    expect(state.tabs.map((t) => t.id)).toEqual(["chat:other", "chat:draft"])
    expect(state.activeTabId).toBe("chat:draft")
    expect(state.workspaceStates["1"].tabs.map((t) => t.id)).toEqual(["chat:keep"])
  })
})

describe("workspaces on several machines", () => {
  const NODE = "node-b"
  const remoteChatTab = (id: string, chatId: number) => ({ ...chatTab(id, chatId), nodeId: NODE })

  it("parks and restores tabs per machine, even for the same workspace id", () => {
    const store = useEditorStore.getState()
    store.setWorkspace(3, 1)
    useEditorStore.setState({ tabs: [chatTab("chat:1", 1)], activeTabId: "chat:1" })

    store.setWorkspace(3, 1, NODE)
    expect(useEditorStore.getState().tabs).toEqual([])
    expect(useEditorStore.getState().currentNodeId).toBe(NODE)
    useEditorStore.setState({ tabs: [remoteChatTab(`chat:${NODE}:1`, 1)], activeTabId: `chat:${NODE}:1` })

    store.setWorkspace(3, 1)
    expect(useEditorStore.getState().tabs.map((t) => t.id)).toEqual(["chat:1"])
    expect(Object.keys(useEditorStore.getState().workspaceStates).sort()).toEqual(["3", "global", `${NODE}:3`])
    expect(useEditorStore.getState().workspaceStates[`${NODE}:3`].tabs.map((t) => t.id)).toEqual([`chat:${NODE}:1`])

    store.setWorkspace(3, 1, NODE)
    expect(useEditorStore.getState().tabs.map((t) => t.id)).toEqual([`chat:${NODE}:1`])
    expect(useEditorStore.getState().activeTabId).toBe(`chat:${NODE}:1`)
    expect(aiSessionCleanup).not.toHaveBeenCalled()
    expect(remoteSessionCleanup).not.toHaveBeenCalled()
  })

  it("drops the machine when there is no workspace", () => {
    useEditorStore.getState().setWorkspace(null, null, NODE)
    expect(useEditorStore.getState().currentNodeId).toBeNull()
  })

  it("gives a new chat the current workspace's machine", () => {
    useEditorStore.getState().setWorkspace(3, 1, NODE)
    const id = useEditorStore.getState().createChatTab("codex")
    expect(useEditorStore.getState().tabs.find((t) => t.id === id)?.nodeId).toBe(NODE)

    useEditorStore.getState().setWorkspace(3, 1)
    const local = useEditorStore.getState().createChatTab("codex")
    expect(useEditorStore.getState().tabs.find((t) => t.id === local)?.nodeId).toBeUndefined()
  })

  it("opens a remote chat by its tab id as that machine's chat, not this machine's same id", () => {
    useEditorStore.setState({ tabs: [chatTab("chat:7", 7)], activeTabId: "chat:7" })

    const id = useEditorStore.getState().openChatTab(`chat:${NODE}:7`, "Remote")

    expect(id).toBe(`chat:${NODE}:7`)
    const tabs = useEditorStore.getState().tabs
    expect(tabs).toHaveLength(2)
    expect(tabs[1]).toMatchObject({ chatId: 7, nodeId: NODE })
  })

  it("finds a chat in the bucket of its own machine", () => {
    useEditorStore.setState({
      tabs: [chatTab("chat:7", 7)],
      currentWorkspaceId: 3,
      workspaceStates: { [`${NODE}:3`]: { tabs: [remoteChatTab(`chat:${NODE}:7`, 7)], activeTabId: `chat:${NODE}:7` } },
    })

    expect(useEditorStore.getState().findChatTab({ chatId: 7 })).toEqual({ workspaceId: 3, tabId: "chat:7" })
    expect(useEditorStore.getState().findChatTab({ nodeId: NODE, chatId: 7 })).toEqual({
      workspaceId: 3,
      nodeId: NODE,
      tabId: `chat:${NODE}:7`,
    })
  })

  it("moves a draft within the current machine", () => {
    useEditorStore.getState().setWorkspace(3, 1, NODE)
    const id = useEditorStore.getState().createChatTab("codex")
    useEditorStore.getState().moveTabToWorkspace(id, 4)
    expect(useEditorStore.getState().workspaceStates[`${NODE}:4`].tabs.map((t) => t.id)).toEqual([id])
    expect(useEditorStore.getState().workspaceStates["4"]).toBeUndefined()
  })

  it("cleans up a closed remote chat on its own machine", () => {
    useEditorStore.setState({ tabs: [remoteChatTab(`chat:${NODE}:42`, 42)], activeTabId: `chat:${NODE}:42` })

    useEditorStore.getState().closeTab(`chat:${NODE}:42`)

    expect(remoteSessionCleanup).toHaveBeenCalledWith(NODE, 42)
    expect(aiSessionCleanup).not.toHaveBeenCalled()
  })

  it("does not count this machine's chat with the same id as another reference", () => {
    useEditorStore.setState({
      tabs: [remoteChatTab(`chat:${NODE}:42`, 42), chatTab("chat:42", 42)],
      activeTabId: `chat:${NODE}:42`,
    })

    useEditorStore.getState().closeTab(`chat:${NODE}:42`)

    expect(remoteSessionCleanup).toHaveBeenCalledWith(NODE, 42)
  })
})
