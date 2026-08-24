import { create } from "zustand"
import type { PanelId, Tab } from "@/components/app-shell/tabs/types"

interface PanelState {
  tabs: Tab[]
  activeTabId: string | null
}

interface TabsState {
  /** Live panels for the currently active workspace. */
  right: PanelState
  bottom: PanelState
  /**
   * Parked panel state for every *inactive* workspace, keyed by workspace id.
   * The active workspace's panels live in `right`/`bottom` (not here) — see
   * `setActiveWorkspace`. This is what makes each project remember its own tabs.
   */
  byWorkspace: Record<string, { right: PanelState; bottom: PanelState }>
  /** Workspace id whose panels are currently live in `right`/`bottom`. */
  currentWorkspaceId: string | null
}

interface TabsActions {
  openTab: (panel: PanelId, tab: Tab, opts?: { activate?: boolean }) => void
  closeTab: (panel: PanelId, tabId: string) => void
  activateTab: (panel: PanelId, tabId: string) => void
  reorderTab: (panel: PanelId, fromIndex: number, toIndex: number) => void
  /**
   * Patch an existing tab's title / icon / payload. Used by content like
   * WorkspaceBrowserTab to sync the tab title with the currently selected
   * file.
   */
  updateTab: (
    panel: PanelId,
    tabId: string,
    patch: Partial<Pick<Tab, "title" | "icon" | "payload">>
  ) => void
  /**
   * Move a tab from one panel to another. `targetIndex === null` appends.
   * Used by cross-panel drag.
   */
  transferTab: (
    from: PanelId,
    to: PanelId,
    tabId: string,
    targetIndex: number | null,
    opts?: { activate?: boolean }
  ) => void
  /**
   * Switch the live panels to `workspaceId`'s bucket: park the current
   * workspace's `right`/`bottom` into `byWorkspace`, then restore the target's
   * (empty for a fresh project). No-op when already on `workspaceId`.
   */
  setActiveWorkspace: (workspaceId: string | null) => void
}

const emptyPanel = (): PanelState => ({ tabs: [], activeTabId: null })

const withClosed = (panel: PanelState, tabId: string): PanelState => {
  const index = panel.tabs.findIndex((t) => t.tabId === tabId)
  if (index < 0) return panel
  const tabs = panel.tabs.slice()
  tabs.splice(index, 1)
  let activeTabId = panel.activeTabId
  if (activeTabId === tabId) {
    // Activate the next tab (or previous if we removed the last one).
    const fallback = tabs[index] ?? tabs[index - 1] ?? null
    activeTabId = fallback?.tabId ?? null
  }
  return { tabs, activeTabId }
}

export const useTabsStore = create<TabsState & TabsActions>()((set) => ({
  right: emptyPanel(),
  bottom: emptyPanel(),
  byWorkspace: {},
  currentWorkspaceId: null,

  openTab: (panel, tab, opts) =>
    set((state) => {
      const current = state[panel]
      const existing = current.tabs.find((t) => t.tabId === tab.tabId)
      if (existing != null) {
        return {
          [panel]: {
            tabs: current.tabs,
            activeTabId: opts?.activate === false ? current.activeTabId : tab.tabId,
          },
        } as Partial<TabsState>
      }
      return {
        [panel]: {
          tabs: [...current.tabs, tab],
          activeTabId: opts?.activate === false ? current.activeTabId : tab.tabId,
        },
      } as Partial<TabsState>
    }),

  closeTab: (panel, tabId) =>
    set((state) => ({ [panel]: withClosed(state[panel], tabId) }) as Partial<TabsState>),

  activateTab: (panel, tabId) =>
    set((state) => {
      if (state[panel].activeTabId === tabId) return {} as Partial<TabsState>
      return { [panel]: { ...state[panel], activeTabId: tabId } } as Partial<TabsState>
    }),

  updateTab: (panel, tabId, patch) =>
    set((state) => {
      const current = state[panel]
      const index = current.tabs.findIndex((t) => t.tabId === tabId)
      if (index < 0) return {} as Partial<TabsState>
      const tabs = current.tabs.slice()
      const existing = tabs[index]
      tabs[index] = {
        ...existing,
        ...patch,
        // Payload is a discriminated union — only replace if the patch carries
        // one, and trust the caller to keep the `type` consistent.
        payload: patch.payload ?? existing.payload,
      } as Tab
      return { [panel]: { ...current, tabs } } as Partial<TabsState>
    }),

  reorderTab: (panel, fromIndex, toIndex) =>
    set((state) => {
      const current = state[panel]
      if (fromIndex === toIndex) return {} as Partial<TabsState>
      const tabs = current.tabs.slice()
      const [moved] = tabs.splice(fromIndex, 1)
      if (moved == null) return {} as Partial<TabsState>
      tabs.splice(toIndex, 0, moved)
      return { [panel]: { ...current, tabs } } as Partial<TabsState>
    }),

  transferTab: (from, to, tabId, targetIndex, opts) =>
    set((state) => {
      if (from === to) return {} as Partial<TabsState>
      const source = state[from]
      const target = state[to]
      const tab = source.tabs.find((t) => t.tabId === tabId)
      if (tab == null) return {} as Partial<TabsState>

      // Remove from source.
      const nextSource = withClosed(source, tabId)

      // Insert into target.
      const insertAt = targetIndex == null ? target.tabs.length : targetIndex
      const nextTargetTabs = target.tabs.slice()
      nextTargetTabs.splice(insertAt, 0, tab)
      const nextTarget: PanelState = {
        tabs: nextTargetTabs,
        activeTabId: opts?.activate === false ? target.activeTabId : tabId,
      }

      return { [from]: nextSource, [to]: nextTarget } as Partial<TabsState>
    }),

  setActiveWorkspace: (workspaceId) =>
    set((state) => {
      if (workspaceId === state.currentWorkspaceId) return {} as Partial<TabsState>
      const byWorkspace = { ...state.byWorkspace }
      // Park the workspace we're leaving (skip the initial null bootstrap).
      if (state.currentWorkspaceId != null) {
        byWorkspace[state.currentWorkspaceId] = { right: state.right, bottom: state.bottom }
      }
      // Restore the target's parked panels, then drop its bucket so the live
      // copy in right/bottom is the single source of truth (no stale dupes for
      // the reapers to keep alive).
      const restored = workspaceId != null ? byWorkspace[workspaceId] : undefined
      if (workspaceId != null) delete byWorkspace[workspaceId]
      return {
        right: restored?.right ?? emptyPanel(),
        bottom: restored?.bottom ?? emptyPanel(),
        byWorkspace,
        currentWorkspaceId: workspaceId,
      }
    }),
}))

/** Convenience selectors. */
export const useRightTabs = () => useTabsStore((s) => s.right)
export const useBottomTabs = () => useTabsStore((s) => s.bottom)

/**
 * Every panel across the live workspace *and* all parked workspaces. The
 * Terminal/Browser reapers use this so switching projects doesn't dispose the
 * instances belonging to a now-inactive (but still open) workspace.
 */
export const getAllPanels = (): PanelState[] => {
  const s = useTabsStore.getState()
  const panels: PanelState[] = [s.right, s.bottom]
  for (const ws of Object.values(s.byWorkspace)) {
    panels.push(ws.right, ws.bottom)
  }
  return panels
}
