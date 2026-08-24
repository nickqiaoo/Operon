import { create } from "zustand"
import { api } from "@/lib/api"
import { trackEvent } from "@/lib/analytics"
import type { EditorTab } from "@/types/editor"

interface EditorState {
  tabs: EditorTab[]
  activeTabId: string
}

export interface CanvasNavigationRequest {
  workflowId: number
  runId?: number
  nodeId?: string
}

/** Jump to a task's detail page — raised by the task card in a chat transcript. */
export interface TaskNavigationRequest {
  projectId: number
  /** Database id (not the per-project `#number`), which is what TasksPage opens by. */
  taskId: number
}

interface EditorStore extends EditorState {
  currentWorkspaceId: number | null
  currentProjectId: number | null
  workspaceStates: Record<string, EditorState>

  // Canvas navigation
  canvasNavigationRequest: CanvasNavigationRequest | null
  requestOpenCanvas: (request: CanvasNavigationRequest) => void
  clearCanvasNavigationRequest: () => void

  // Task navigation
  taskNavigationRequest: TaskNavigationRequest | null
  requestOpenTask: (request: TaskNavigationRequest) => void
  clearTaskNavigationRequest: () => void

  setWorkspace: (workspaceId: number | null, projectId: number | null) => void
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
  setTabChatId: (tabId: string, chatId: number) => void
  openDiff: (path: string, content: string) => void
  updateTabTitle: (id: string, title: string) => void
  updateTabProvider: (id: string, provider: string) => void
  updateTabProviderId: (id: string, providerId: string) => void
  clearTabInputAttachment: (id: string) => void
}

const getBasename = (filePath: string) => {
  const normalized = filePath.replace(/[\\/]+$/, "")
  const parts = normalized.split(/[/\\]/)
  return parts[parts.length - 1] || normalized
}

const persistedChatIdFromTabId = (tabId: string): number | undefined => {
  const match = /^chat:(\d+)$/.exec(tabId)
  if (!match) return undefined
  const chatId = Number.parseInt(match[1], 10)
  return chatId > 0 ? chatId : undefined
}

const hasOtherChatReference = (
  state: Pick<EditorStore, "tabs" | "workspaceStates" | "currentWorkspaceId">,
  closedTabId: string,
  chatId: number,
): boolean => {
  const currentWorkspaceKey = String(state.currentWorkspaceId ?? "global")
  if (
    state.tabs.some(
      (tab) => tab.id !== closedTabId && tab.type === "chat" && tab.chatId === chatId,
    )
  ) {
    return true
  }

  return Object.entries(state.workspaceStates).some(
    ([workspaceKey, workspaceState]) =>
      workspaceKey !== currentWorkspaceKey &&
      workspaceState.tabs.some((tab) => tab.type === "chat" && tab.chatId === chatId),
  )
}


export const useEditorStore = create<EditorStore>()(
  (set, get) => ({
  tabs: [],
  activeTabId: "",
  currentWorkspaceId: null,
  currentProjectId: null,
  workspaceStates: {},
  canvasNavigationRequest: null,

  requestOpenCanvas: (request) => set({ canvasNavigationRequest: request }),
  clearCanvasNavigationRequest: () => set({ canvasNavigationRequest: null }),

  taskNavigationRequest: null,
  requestOpenTask: (request) => set({ taskNavigationRequest: request }),
  clearTaskNavigationRequest: () => set({ taskNavigationRequest: null }),

  setWorkspace: (workspaceId, projectId) => {
    const state = get()
    // Skip if workspace hasn't changed
    if (state.currentWorkspaceId === workspaceId && state.currentProjectId === projectId) return
    // Save current state
    const currentId = state.currentWorkspaceId
    const newStates = { ...state.workspaceStates }

    if (currentId) {
      newStates[currentId] = {
        tabs: state.tabs,
        activeTabId: state.activeTabId
      }
    } else {
      // Save global state
      newStates['global'] = {
        tabs: state.tabs,
        activeTabId: state.activeTabId
      }
    }

    // Load new state
    const nextState = newStates[workspaceId ?? 'global'] || { tabs: [], activeTabId: "" }

    set({
      currentWorkspaceId: workspaceId,
      currentProjectId: projectId,
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
    const state = get()
    const closedTab = state.tabs.find((tab) => tab.id === id)
    const shouldCleanupChat =
      closedTab?.type === "chat" &&
      closedTab.chatId !== undefined &&
      !hasOtherChatReference(state, id, closedTab.chatId)
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
    if (shouldCleanupChat && closedTab.chatId !== undefined) {
      api.aiSessionCleanup(closedTab.chatId).catch((e) => {
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
    const persistedChatId = persistedChatIdFromTabId(tabId)
    const existing = state.tabs.find(
      (tab) =>
        tab.type === "chat" &&
        (tab.id === tabId ||
          (persistedChatId !== undefined && tab.chatId === persistedChatId))
    )
    if (existing) {
      if (options) {
        set({
          tabs: state.tabs.map((t) => (t.id === existing.id ? { ...t, options: { ...t.options, ...options } } : t)),
          activeTabId: options.background ? state.activeTabId : existing.id,
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
      chatId: persistedChatId,
    }
    set({
      tabs: [...state.tabs, newTab],
      activeTabId: options?.background ? state.activeTabId : newTab.id,
    })
    return newTab.id
  },

  setTabChatId: (tabId: string, chatId: number) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, chatId } : tab)),
    }))
  },

  openDiff: (path, content) => {
    const state = get()
    const id = `diff:${path}`
    const title = `${getBasename(path)} (diff)`
    const existing = state.tabs.find((tab) => tab.id === id)
    if (existing) {
      set({
        tabs: state.tabs.map((tab) =>
          tab.id === id
            ? { ...tab, content, title, filePath: path, type: "diff" }
            : tab
        ),
        activeTabId: id,
      })
      return
    }

    const newTab: EditorTab = {
      id,
      title,
      type: "diff",
      filePath: path,
      content,
    }
    set({
      tabs: [...state.tabs, newTab],
      activeTabId: id,
    })
    trackEvent('diff_opened', { extension: path.split('.').pop() })
  },

  updateTabTitle: (id, title) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, title } : tab)),
    }))
  },

  updateTabProvider: (id, provider) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, provider } : tab)),
    }))
  },

  updateTabProviderId: (id, providerId) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, providerId } : tab)),
    }))
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
