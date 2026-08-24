import { useEditorStore } from '@/stores/editor-store'
import { useStreamingStore } from '@/stores/streaming-store'
import { useNotificationStore } from '@/stores/notification-store'
import { useAppShellStore } from '@/stores/app-shell-store'
import { useTabsStore } from '@/stores/tabs-store'
import { useProjectStore } from '@/stores/project-store'
import type { Tab } from '@/components/app-shell/tabs/types'

type StreamState = 'idle' | 'streaming'

export interface OperonProbeTab {
  id: string
  chatId?: number
  providerId?: string
  title: string
  type: string
  options?: Record<string, unknown>
}

/** A single tab inside the app-shell right/bottom panel (useTabsStore). */
export interface OperonProbePanelTab {
  tabId: string
  /** Payload discriminator: workspace-browser | review | browser | terminal | diff | placeholder. */
  type: string
  title: string
}

export interface OperonProbePanel {
  /** Whether the panel is currently open (app-shell store). */
  open: boolean
  /** Right panel can expand to take over the center column; always false for bottom. */
  expanded: boolean
  /** Active tab id within the panel, or null when empty. */
  activeTabId: string | null
  tabs: OperonProbePanelTab[]
}

export interface OperonProbePanels {
  right: OperonProbePanel
  bottom: OperonProbePanel
}

export interface OperonProbeProjectInfo {
  activeProjectId: number | null
  activeWorkspaceId: number | null
  projectCount: number
  workspaceCount: number
}

export interface OperonProbe {
  /** id of the editor tab currently in focus. */
  activeTabId(): string
  /** chat id of the active chat tab, if any. */
  activeChatId(): number | undefined
  /** All editor tabs (chat / file / diff) in display order. */
  tabs(): OperonProbeTab[]
  /** Streaming state of the active tab. */
  streamState(): StreamState
  /** Tab ids that are currently streaming. */
  streamingTabIds(): string[]
  /** Tab ids that finished streaming but the user hasn't visited yet. */
  unseenTabIds(): string[]
  /** Snapshot of a specific tab's options (model/mode/thinking/etc). */
  tabState(tabId: string): OperonProbeTab | undefined
  /** Active project + workspace ids. */
  workspace(): { projectId: number | null; workspaceId: number | null }
  /** Outstanding toast notifications. */
  notifications(): Array<{ id: string; type: string; message: string }>
  /**
   * Number of currently rendered chat messages in the active tab. Read from
   * the DOM (`data-testid="message-user|assistant"`) so it reflects what the
   * user actually sees.
   */
  messageCount(): number
  /**
   * IDs of pending tool-approval dialogs in the DOM, in display order.
   * Each entry corresponds to a `data-testid="permission-dialog"` element.
   */
  pendingApprovals(): number
  /**
   * App-shell side (right) + bottom panel open/expanded state and their tab
   * stacks. Reads useAppShellStore + useTabsStore — distinct from `tabs()`,
   * which is the center chat/file/diff editor (useEditorStore).
   */
  panels(): OperonProbePanels
  /** Active project / workspace ids and counts (useProjectStore). */
  project(): OperonProbeProjectInfo
}

declare global {
  interface Window {
    __operon?: OperonProbe
  }
}

function shouldInstall(): boolean {
  if (typeof window === 'undefined') return false
  if (import.meta.env.DEV) return true
  return import.meta.env.VITE_OPERON_ENABLE_PROBE === '1'
}

export function installOperonProbe(): void {
  if (!shouldInstall()) return

  const tabSnapshot = (tab: ReturnType<typeof useEditorStore.getState>['tabs'][number]): OperonProbeTab => ({
    id: tab.id,
    chatId: tab.chatId,
    providerId: tab.providerId,
    title: tab.title,
    type: tab.type,
    options: tab.options as Record<string, unknown> | undefined,
  })

  const probe: OperonProbe = {
    activeTabId: () => useEditorStore.getState().activeTabId,
    activeChatId: () => {
      const state = useEditorStore.getState()
      const tab = state.tabs.find((t) => t.id === state.activeTabId)
      return tab?.chatId
    },
    tabs: () => useEditorStore.getState().tabs.map(tabSnapshot),
    streamState: () => {
      const { activeTabId } = useEditorStore.getState()
      const streaming = useStreamingStore.getState().streamingTabIds
      return activeTabId && streaming.has(activeTabId) ? 'streaming' : 'idle'
    },
    streamingTabIds: () => Array.from(useStreamingStore.getState().streamingTabIds),
    unseenTabIds: () => {
      const state = useStreamingStore.getState() as { unseenTabIds?: Set<string> }
      return state.unseenTabIds ? Array.from(state.unseenTabIds) : []
    },
    tabState: (tabId: string) => {
      const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId)
      return tab ? tabSnapshot(tab) : undefined
    },
    workspace: () => {
      const state = useEditorStore.getState() as {
        currentProjectId?: number | null
        currentWorkspaceId?: number | null
      }
      return {
        projectId: state.currentProjectId ?? null,
        workspaceId: state.currentWorkspaceId ?? null,
      }
    },
    notifications: () => {
      const store = useNotificationStore.getState() as {
        notifications?: Array<{ id: string; type: string; message: string }>
      }
      return store.notifications ?? []
    },
    messageCount: () => {
      if (typeof document === 'undefined') return 0
      return document.querySelectorAll('[data-testid^="message-"]').length
    },
    pendingApprovals: () => {
      if (typeof document === 'undefined') return 0
      return document.querySelectorAll('[data-testid="permission-dialog"]').length
    },
    panels: () => {
      const shell = useAppShellStore.getState()
      const tabsState = useTabsStore.getState()
      const snapshot = (
        panel: { tabs: Tab[]; activeTabId: string | null },
        open: boolean,
        expanded: boolean,
      ): OperonProbePanel => ({
        open,
        expanded,
        activeTabId: panel.activeTabId,
        tabs: panel.tabs.map((t) => ({ tabId: t.tabId, type: t.payload.type, title: t.title })),
      })
      return {
        right: snapshot(tabsState.right, shell.rightPanelOpen, shell.rightPanelExpanded),
        bottom: snapshot(tabsState.bottom, shell.bottomPanelOpen, false),
      }
    },
    project: () => {
      const state = useProjectStore.getState()
      return {
        activeProjectId: state.activeProjectId,
        activeWorkspaceId: state.activeWorkspaceId,
        projectCount: state.projects.length,
        workspaceCount: state.projects.reduce((n, p) => n + p.workspaces.length, 0),
      }
    },
  }

  Object.freeze(probe)
  window.__operon = probe
}
