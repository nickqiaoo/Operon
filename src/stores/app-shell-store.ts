import { create } from "zustand"
import { persist } from "zustand/middleware"
import {
  BOTTOM_PANEL_DEFAULT_HEIGHT,
  RIGHT_PANEL_DEFAULT_WIDTH,
  STORAGE_KEY,
} from "@/components/app-shell/constants"

interface AppShellState {
  rightPanelOpen: boolean
  bottomPanelOpen: boolean
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
}

interface AppShellActions {
  setRightPanelOpen: (open: boolean) => void
  setBottomPanelOpen: (open: boolean) => void
  toggleRightPanel: () => void
  toggleBottomPanel: () => void
  setRightPanelWidth: (width: number) => void
  setBottomPanelHeight: (height: number) => void
  toggleRightPanelExpanded: () => void
  toggleWorkspaceTree: (tabId: string) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleSidebar: () => void
}

export const useAppShellStore = create<AppShellState & AppShellActions>()(
  persist(
    (set) => ({
      rightPanelOpen: false,
      bottomPanelOpen: false,
      rightPanelWidth: RIGHT_PANEL_DEFAULT_WIDTH,
      bottomPanelHeight: BOTTOM_PANEL_DEFAULT_HEIGHT,
      rightPanelExpanded: false,
      sidebarCollapsed: false,
      workspaceTreeHidden: {},

      setRightPanelOpen: (rightPanelOpen) =>
        set((s) => ({
          rightPanelOpen,
          // Auto-collapse expansion when the panel itself closes.
          rightPanelExpanded: rightPanelOpen ? s.rightPanelExpanded : false,
        })),
      setBottomPanelOpen: (bottomPanelOpen) => set({ bottomPanelOpen }),
      toggleRightPanel: () =>
        set((s) => ({
          rightPanelOpen: !s.rightPanelOpen,
          rightPanelExpanded: s.rightPanelOpen ? false : s.rightPanelExpanded,
        })),
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
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    }),
    {
      name: STORAGE_KEY,
      // v1 raised the right-panel maximum width. Drop the older persisted
      // value once so existing installs start from the current default.
      version: 1,
      migrate: (persisted, version) => {
        if (version >= 1 || persisted == null) return persisted as never
        const { rightPanelWidth: _dropped, ...rest } = persisted as Record<string, unknown>
        return rest as never
      },
      partialize: (s) => ({
        rightPanelOpen: s.rightPanelOpen,
        bottomPanelOpen: s.bottomPanelOpen,
        rightPanelWidth: s.rightPanelWidth,
        bottomPanelHeight: s.bottomPanelHeight,
      }),
    }
  )
)
