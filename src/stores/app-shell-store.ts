import { create } from "zustand"
import { persist } from "zustand/middleware"
import { useSessionPanelStore } from "./session-panel-store"
import {
  BOTTOM_PANEL_DEFAULT_HEIGHT,
  RIGHT_PANEL_AUTO_CLOSE_BELOW,
  RIGHT_PANEL_DEFAULT_WIDTH,
  STORAGE_KEY,
} from "@/components/app-shell/constants"

interface AppShellState {
  /** Open state of the panels in the live workspace; see `switchPanelWorkspace`. */
  rightPanelOpen: boolean
  bottomPanelOpen: boolean
  /** Parked workspaces that had a panel open when they were left. */
  panelsOpenByWorkspace: Record<string, ParkedPanelsOpen>
  /** Workspace the live open state belongs to; null until the shell first binds one. */
  panelWorkspaceKey: string | null
  rightPanelWidth: number
  bottomPanelHeight: number
  /** When true the right panel takes over the center column area. */
  rightPanelExpanded: boolean
  /**
   * Left project sidebar collapsed. Lives here rather than in App's local state
   * because panels need it to know whether they are the leftmost surface — an
   * expanded right panel with the sidebar collapsed sits under the macOS
   * traffic lights and has to reserve room for them. Not persisted (matches the
   * previous `useState` behaviour: every launch starts expanded).
   */
  sidebarCollapsed: boolean
  /**
   * Per-tab visibility of the workspace-browser file tree. Default is visible;
   * a `true` entry means the user explicitly hid it. Transient — not persisted.
   */
  workspaceTreeHidden: Record<string, boolean>
  /**
   * Per-tab back/forward history of files previewed in the workspace browser.
   * `entries` runs oldest -> newest and `index` points at the file on screen,
   * so anything after `index` is the "forward" stack. Transient — not
   * persisted, and kept here (rather than in the tab payload) so it survives
   * switching workspaces, which unmounts the tab.
   */
  workspacePreviewHistory: Record<string, WorkspacePreviewHistory>
  /**
   * User ticked "don't ask again" on the side chat close confirmation. Persisted:
   * it is a standing answer to a question they have already made up their mind
   * about, not session state.
   */
  skipSideChatCloseConfirm: boolean
}

interface ParkedPanelsOpen {
  right: boolean
  bottom: boolean
}

export interface WorkspacePreviewHistory {
  entries: string[]
  index: number
}

/** Cap on remembered files per tab; older entries fall off the front. */
const MAX_WORKSPACE_PREVIEW_HISTORY = 50

interface AppShellActions {
  setRightPanelOpen: (open: boolean) => void
  /**
   * Park the panels' open state under the workspace being left and restore the
   * target's (closed if it never had one). The first call only records the key:
   * the persisted open state belongs to the workspace the app reopens in.
   */
  switchPanelWorkspace: (workspaceKey: string) => void
  setBottomPanelOpen: (open: boolean) => void
  toggleRightPanel: () => void
  toggleBottomPanel: () => void
  setRightPanelWidth: (width: number) => void
  setBottomPanelHeight: (height: number) => void
  toggleRightPanelExpanded: () => void
  toggleWorkspaceTree: (tabId: string) => void
  /**
   * Record `path` as the file now shown in tab `tabId`. Drops the forward
   * stack, like a browser does when you navigate after going back. No-op when
   * `path` is already the current entry, which is what keeps back/forward
   * itself from re-recording where it just went.
   */
  pushWorkspacePreviewHistory: (tabId: string, path: string) => void
  /**
   * Step the history cursor by `delta` (-1 back, +1 forward) and return the
   * file to show, or `null` when there is nothing that way.
   */
  stepWorkspacePreviewHistory: (tabId: string, delta: number) => string | null
  setSkipSideChatCloseConfirm: (skip: boolean) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleSidebar: () => void
}

export const useAppShellStore = create<AppShellState & AppShellActions>()(
  persist(
    (set, get) => ({
      rightPanelOpen: false,
      bottomPanelOpen: false,
      panelsOpenByWorkspace: {},
      panelWorkspaceKey: null,
      rightPanelWidth: RIGHT_PANEL_DEFAULT_WIDTH,
      bottomPanelHeight: BOTTOM_PANEL_DEFAULT_HEIGHT,
      rightPanelExpanded: false,
      sidebarCollapsed: false,
      workspaceTreeHidden: {},
      workspacePreviewHistory: {},
      skipSideChatCloseConfirm: false,

      setRightPanelOpen: (rightPanelOpen) => {
        // Keep the transcript readable when the right panel takes its space.
        if (rightPanelOpen && !get().rightPanelOpen) {
          useSessionPanelStore.getState().setOpen(false)
        }
        set((s) => ({
          rightPanelOpen,
          // Auto-collapse expansion when the panel itself closes.
          rightPanelExpanded: rightPanelOpen ? s.rightPanelExpanded : false,
        }))
      },
      switchPanelWorkspace: (workspaceKey) => {
        const state = get()
        const leaving = state.panelWorkspaceKey
        if (leaving === workspaceKey) return
        if (leaving == null) {
          set({ panelWorkspaceKey: workspaceKey })
          return
        }
        const { [workspaceKey]: restored, ...parked } = state.panelsOpenByWorkspace
        const { rightPanelOpen: right, bottomPanelOpen: bottom } = state
        set({
          panelsOpenByWorkspace: right || bottom ? { ...parked, [leaving]: { right, bottom } } : parked,
          panelWorkspaceKey: workspaceKey,
          bottomPanelOpen: restored?.bottom ?? false,
        })
        // Through the setter, so the same rules hold as for any other open or close.
        state.setRightPanelOpen(restored?.right ?? false)
      },
      setBottomPanelOpen: (bottomPanelOpen) => set({ bottomPanelOpen }),
      toggleRightPanel: () => get().setRightPanelOpen(!get().rightPanelOpen),
      toggleBottomPanel: () =>
        set((s) => ({ bottomPanelOpen: !s.bottomPanelOpen })),
      setRightPanelWidth: (rightPanelWidth) => set({ rightPanelWidth }),
      setBottomPanelHeight: (bottomPanelHeight) => set({ bottomPanelHeight }),
      toggleRightPanelExpanded: () =>
        set((s) => ({ rightPanelExpanded: !s.rightPanelExpanded })),
      toggleWorkspaceTree: (tabId) =>
        set((s) => ({
          workspaceTreeHidden: {
            ...s.workspaceTreeHidden,
            [tabId]: !s.workspaceTreeHidden[tabId],
          },
        })),
      pushWorkspacePreviewHistory: (tabId, path) =>
        set((s) => {
          const current = s.workspacePreviewHistory[tabId]
          if (current != null && current.entries[current.index] === path) return {}
          const kept =
            current == null ? [] : current.entries.slice(0, current.index + 1)
          const entries = [...kept, path].slice(-MAX_WORKSPACE_PREVIEW_HISTORY)
          return {
            workspacePreviewHistory: {
              ...s.workspacePreviewHistory,
              [tabId]: { entries, index: entries.length - 1 },
            },
          }
        }),
      stepWorkspacePreviewHistory: (tabId, delta) => {
        const current = get().workspacePreviewHistory[tabId]
        if (current == null) return null
        const index = current.index + delta
        const path = current.entries[index]
        if (path == null) return null
        set((s) => ({
          workspacePreviewHistory: {
            ...s.workspacePreviewHistory,
            [tabId]: { entries: current.entries, index },
          },
        }))
        return path
      },
      setSkipSideChatCloseConfirm: (skipSideChatCloseConfirm) =>
        set({ skipSideChatCloseConfirm }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    }),
    {
      name: STORAGE_KEY,
      // v1 raised the maximum width. v2 repairs widths saved while the editor
      // was hidden: users cannot drag below the auto-close threshold.
      version: 2,
      migrate: (persisted, version) => {
        if (persisted == null) return persisted as never
        const state = persisted as Record<string, unknown>
        if (version < 1 || (
          version < 2 && typeof state.rightPanelWidth === "number" &&
          state.rightPanelWidth < RIGHT_PANEL_AUTO_CLOSE_BELOW
        )) {
          return { ...state, rightPanelWidth: RIGHT_PANEL_DEFAULT_WIDTH } as never
        }
        return state as never
      },
      partialize: (s) => ({
        rightPanelOpen: s.rightPanelOpen,
        bottomPanelOpen: s.bottomPanelOpen,
        panelsOpenByWorkspace: s.panelsOpenByWorkspace,
        panelWorkspaceKey: s.panelWorkspaceKey,
        rightPanelWidth: s.rightPanelWidth,
        bottomPanelHeight: s.bottomPanelHeight,
        skipSideChatCloseConfirm: s.skipSideChatCloseConfirm,
      }),
    }
  )
)
