import { create } from "zustand"
import { api, apiFor } from "@/lib/api"
import { chatRefFromTabId, chatRefOfTab, chatTabId, parseWorkspaceBucketKey, sameChat, workspaceBucketKey, type ChatRef } from "@/lib/chat-ref"
import { trackEvent } from "@/lib/analytics"
import { clearChatDraft } from "@/lib/chat-drafts"
import type { EditorTab } from "@/types/editor"

interface EditorState {
  tabs: EditorTab[]
  activeTabId: string
}

interface EditorStore extends EditorState {
  currentWorkspaceId: number | null
  currentProjectId: number | null
  /**
   * The machine the current workspace is on; null for this one. A workspace's
   * tabs all show chats of its machine, and new chats opened in it are made there.
   */
  currentNodeId: string | null
  /** Buckets by `workspaceBucketKey` (`"global"`, `"3"`, `"<nodeId>:3"`). */
  workspaceStates: Record<string, EditorState>

  /** Switch tab buckets. Follows the project store; call it from workspace-sync.ts only. */
  setWorkspace: (workspaceId: number | null, projectId: number | null, nodeId?: string | null) => void
  setActiveTab: (id: string) => void
  closeTab: (id: string) => void
  createChatTab: (providerId: string, title?: string, options?: EditorTab['options'], isSubAgent?: boolean) => string
  createTerminalTab: (opts: { providerId: string; launch: string; cwd?: string; title?: string }) => string
  /**
   * Open (or focus) the tab for a chat. Returns the id of the tab that ended up
   * active, which is NOT always the requested one: a chat already open under a
   * session-local tab id is reused, so a caller tracking the open tab itself must
   * follow this id rather than the one it passed in.
   */
  openChatTab: (chatId: string, title?: string, options?: EditorTab['options'], providerId?: string, isSubAgent?: boolean) => string
  /**
   * Where a persisted chat is already open as an editor tab: the current workspace first, then
   * the others. `workspaceId` is null for the global bucket. Side chats are not editor tabs.
   */
  findChatTab: (chat: ChatRef) => { workspaceId: number | null; nodeId?: string; tabId: string } | undefined
  setTabChatId: (tabId: string, chatId: number) => void
  /**
   * Register a side chat so ChatPanel can find its state. Never activated and
   * never shown in the editor tab strip — the right-panel tab owning it is the
   * only way in. Returns the editor tab id to hand to ChatPanel.
   */
  openSideChatTab: (chat: ChatRef, title: string, providerId?: string) => string
  updateTabTitle: (id: string, title: string) => void
  updateTabProvider: (id: string, provider: string) => void
  updateTabProviderId: (id: string, providerId: string) => void
  /** Switch the agent of a chat that has not been sent yet; remounts its panel. */
  switchDraftProvider: (id: string, providerId: string) => void
  setDraftAdditionalEnvironments: (id: string, environments: EditorTab["additionalSshEnvironments"]) => void
  setDraftSshEnvironment: (id: string, environment: EditorTab["sshEnvironment"]) => void
  /**
   * Move a tab of the current workspace into another workspace's bucket, where
   * it becomes the active tab. The caller then activates that workspace.
   */
  moveTabToWorkspace: (id: string, workspaceId: number | null) => void
  clearTabInputAttachment: (id: string) => void
}


/**
 * Set one field on a tab, leaving the store untouched when it already holds
 * that value. Each chat panel sets its title and provider as it mounts, and a
 * new `tabs` array re-renders the shell and every message row of every chat.
 */
const patchTab = <K extends keyof EditorTab>(
  state: Pick<EditorStore, "tabs">,
  id: string,
  key: K,
  value: EditorTab[K],
): Pick<EditorStore, "tabs"> => {
  const index = state.tabs.findIndex((tab) => tab.id === id)
  if (index < 0 || state.tabs[index][key] === value) return state
  const tabs = state.tabs.slice()
  tabs[index] = { ...tabs[index], [key]: value }
  return { tabs }
}

const hasOtherChatReference = (
  state: Pick<EditorStore, "tabs" | "workspaceStates" | "currentWorkspaceId" | "currentNodeId">,
  closedTabId: string,
  chat: ChatRef,
): boolean => {
  const currentWorkspaceKey = workspaceBucketKey(state.currentWorkspaceId, state.currentNodeId)
  if (
    state.tabs.some(
      (tab) => tab.id !== closedTabId && tab.type === "chat" && sameChat(chatRefOfTab(tab), chat),
    )
  ) {
    return true
  }

  return Object.entries(state.workspaceStates).some(
    ([workspaceKey, workspaceState]) =>
      workspaceKey !== currentWorkspaceKey &&
      workspaceState.tabs.some((tab) => tab.type === "chat" && sameChat(chatRefOfTab(tab), chat)),
  )
}


export const useEditorStore = create<EditorStore>()(
  (set, get) => ({
  tabs: [],
  activeTabId: "",
  currentWorkspaceId: null,
  currentProjectId: null,
  currentNodeId: null,
  workspaceStates: {},

  setWorkspace: (workspaceId, projectId, nodeId = null) => {
    const state = get()
    const nextNodeId = workspaceId == null ? null : nodeId ?? null
    // Skip if workspace hasn't changed
    if (
      state.currentWorkspaceId === workspaceId &&
      state.currentProjectId === projectId &&
      state.currentNodeId === nextNodeId
    ) return
    // Park the current bucket under its machine-qualified key.
    const newStates = { ...state.workspaceStates }
    newStates[workspaceBucketKey(state.currentWorkspaceId || null, state.currentNodeId)] = {
      tabs: state.tabs,
      activeTabId: state.activeTabId,
    }

    // Load new state
    const nextState = newStates[workspaceBucketKey(workspaceId, nextNodeId)] || { tabs: [], activeTabId: "" }

    set({
      currentWorkspaceId: workspaceId,
      currentProjectId: projectId,
      currentNodeId: nextNodeId,
      workspaceStates: newStates,
      tabs: nextState.tabs,
      activeTabId: nextState.activeTabId
    })
  },

  setActiveTab: (id) => {
    const state = get()
    if (state.tabs.some((t) => t.id === id)) {
      set({ activeTabId: id })
    }
  },

  closeTab: (id) => {
    clearChatDraft(id)
    const state = get()
    const closedTab = state.tabs.find((tab) => tab.id === id)
    const closedChat = closedTab?.type === "chat" ? chatRefOfTab(closedTab) : undefined
    const shouldCleanupChat = closedChat !== undefined && !hasOtherChatReference(state, id, closedChat)
    const nextTabs = state.tabs.filter((tab) => tab.id !== id)
    let nextActive = state.activeTabId
    if (state.activeTabId === id) {
      nextActive = nextTabs[0]?.id ?? ""
    }
    set({
      tabs: nextTabs,
      activeTabId: nextActive,
    })

    // Different frontend tabs can temporarily reference the same persisted chat
    // (for example, an older build opened a duplicate from Inbox). Only the last
    // open reference owns session cleanup; closing one view must not abort the
    // runtime still displayed by another tab.
    if (shouldCleanupChat) {
      // On the machine the chat lives on. `api` itself for a local one, so the
      // local path is what it always was.
      const chatApi = closedChat.nodeId ? apiFor(closedChat.nodeId) : api
      chatApi.aiSessionCleanup(closedChat.chatId).catch((e) => {
        console.warn('[editor-store] Session cleanup failed:', e)
      })
    }

    // Tear down the xterm instance + kill the PTY when closing a terminal tab.
    // Dynamic import avoids a static cycle (TerminalManager imports this store).
    if (closedTab?.type === "terminal" && closedTab.terminalId !== undefined) {
      const terminalId = closedTab.terminalId
      void import("@/components/terminal/TerminalManager").then((m) => {
        m.terminalManager.dispose(terminalId)
      })
    }
  },

  createChatTab: (providerId: string, title = "Chat", options?: EditorTab['options'], isSubAgent?: boolean) => {
    const id = `chat:${crypto.randomUUID()}`

    const newTab: EditorTab = {
      id,
      title,
      type: "chat",
      closable: true,
      // chatId is undefined — set after first DB save via setTabChatId
      // A new chat belongs to the workspace it is opened in, so to its machine.
      ...(get().currentNodeId ? { nodeId: get().currentNodeId ?? undefined } : {}),
      providerId,
      isSubAgent,
      options,
    }
    const state = get()
    set({
      tabs: [...state.tabs, newTab],
      activeTabId: options?.background ? state.activeTabId : id,
    })
    trackEvent('chat_created', { provider_id: providerId })
    return id
  },

  createTerminalTab: ({ providerId, launch, cwd, title = "Claude" }) => {
    const id = `terminal:${crypto.randomUUID()}`
    const newTab: EditorTab = {
      id,
      title,
      type: "terminal",
      closable: true,
      providerId,
      terminalId: id,
      launch,
      cwd,
    }
    const state = get()
    set({
      tabs: [...state.tabs, newTab],
      activeTabId: id,
    })
    trackEvent('terminal_created', { provider_id: providerId })
    return id
  },

  openChatTab: (tabId, title = "Chat", options?: EditorTab['options'], providerId?: string, isSubAgent?: boolean) => {
    const state = get()
    // `chat:12` / `chat:<nodeId>:12`: the tab id names which chat, on which machine.
    const persisted = chatRefFromTabId(tabId)
    const existing = state.tabs.find(
      (tab) =>
        tab.type === "chat" &&
        (tab.id === tabId || (persisted !== undefined && sameChat(chatRefOfTab(tab), persisted)))
    )
    if (existing) {
      if (options || providerId !== undefined || isSubAgent !== undefined) {
        set({
          tabs: state.tabs.map((tab) => tab.id === existing.id ? {
            ...tab,
            ...(options ? { options: { ...tab.options, ...options } } : {}),
            ...(providerId !== undefined ? { providerId } : {}),
            ...(isSubAgent !== undefined ? { isSubAgent } : {}),
          } : tab),
          activeTabId: options?.background ? state.activeTabId : existing.id,
        })
      } else {
        set({ activeTabId: existing.id })
      }
      return existing.id
    }
    const newTab: EditorTab = {
      id: tabId,
      title,
      type: "chat",
      closable: true,
      providerId,
      isSubAgent,
      options,
      chatId: persisted?.chatId,
      ...(persisted?.nodeId ? { nodeId: persisted.nodeId } : {}),
    }
    set({
      tabs: [...state.tabs, newTab],
      activeTabId: options?.background ? state.activeTabId : newTab.id,
    })
    return newTab.id
  },

  findChatTab: (chat) => {
    const state = get()
    const tabId = chatTabId(chat)
    const matches = (tab: EditorTab) =>
      tab.type === "chat" && !tab.isSideChat && (sameChat(chatRefOfTab(tab), chat) || tab.id === tabId)
    const current = state.tabs.find(matches)
    if (current) {
      return { workspaceId: state.currentWorkspaceId, ...(state.currentNodeId ? { nodeId: state.currentNodeId } : {}), tabId: current.id }
    }
    const currentKey = workspaceBucketKey(state.currentWorkspaceId, state.currentNodeId)
    for (const [key, bucket] of Object.entries(state.workspaceStates)) {
      if (key === currentKey) continue
      const tab = bucket.tabs.find(matches)
      if (tab) return { ...parseWorkspaceBucketKey(key), tabId: tab.id }
    }
    return undefined
  },

  openSideChatTab: (chat, title, providerId) => {
    const tabId = chatTabId(chat)
    const state = get()
    if (state.tabs.some((tab) => tab.id === tabId)) return tabId
    set({
      tabs: [
        ...state.tabs,
        {
          id: tabId,
          title,
          type: "chat",
          closable: true,
          providerId,
          isSideChat: true,
          chatId: chat.chatId,
          ...(chat.nodeId ? { nodeId: chat.nodeId } : {}),
        },
      ],
    })
    return tabId
  },

  setTabChatId: (tabId: string, chatId: number) => {
    set((state) => patchTab(state, tabId, "chatId", chatId))
  },

  updateTabTitle: (id, title) => {
    set((state) => patchTab(state, id, "title", title))
  },

  updateTabProvider: (id, provider) => {
    set((state) => patchTab(state, id, "provider", provider))
  },

  updateTabProviderId: (id, providerId) => {
    set((state) => patchTab(state, id, "providerId", providerId))
  },

  switchDraftProvider: (id, providerId) => {
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === id)
      if (index < 0) return state
      const tab = state.tabs[index]
      if (tab.chatId !== undefined || tab.providerId === providerId) return state
      const tabs = state.tabs.slice()
      tabs[index] = { ...tab, providerId, provider: undefined, additionalSshEnvironments: undefined, sshEnvironment: undefined, mountRev: (tab.mountRev ?? 0) + 1 }
      return { tabs }
    })
  },

  setDraftAdditionalEnvironments: (id, environments) => {
    set((state) => {
      const tab = state.tabs.find(item => item.id === id)
      if (!tab || tab.chatId !== undefined || tab.providerId !== 'custom') return state
      return patchTab(state, id, "additionalSshEnvironments", environments)
    })
  },

  setDraftSshEnvironment: (id, environment) => {
    set((state) => {
      const tab = state.tabs.find((item) => item.id === id)
      if (!tab || tab.chatId !== undefined || tab.providerId !== 'custom') return state
      return patchTab(state, id, "sshEnvironment", environment)
    })
  },

  moveTabToWorkspace: (id, workspaceId) => {
    const state = get()
    if (workspaceId === state.currentWorkspaceId) return
    const tab = state.tabs.find((t) => t.id === id)
    if (!tab) return
    const tabs = state.tabs.filter((t) => t.id !== id)
    // Within the current machine: a tab's chat lives where it lives.
    const targetKey = workspaceBucketKey(workspaceId, state.currentNodeId)
    const target = state.workspaceStates[targetKey] ?? { tabs: [], activeTabId: "" }
    set({
      tabs,
      activeTabId: state.activeTabId === id ? (tabs[0]?.id ?? "") : state.activeTabId,
      workspaceStates: {
        ...state.workspaceStates,
        [targetKey]: { tabs: [...target.tabs, tab], activeTabId: id },
      },
    })
  },

  clearTabInputAttachment: (id) => {
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id && tab.options?.inputAttachment
          ? { ...tab, options: { ...tab.options, inputAttachment: undefined } }
          : tab
      ),
    }))
  },
}),
)
