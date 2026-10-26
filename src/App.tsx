import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { installBrowserUseBridge } from "@/components/browser/browser-use-bridge"
import { useIntl } from "react-intl"
import { PanelLeft } from "lucide-react"
import { cn } from "@/lib/utils"
import { PageVisibleContext } from "@/lib/page-visibility"
import { Toaster } from "sonner"
import { TERMINAL_CLI_LAUNCH } from "@/lib/terminal-clis"
import { createPortal } from "react-dom"
import { AnnotationEditorHost } from "@/components/browser/AnnotationEditorHost"

import { LeftSidebar } from "@/components/app-shell/LeftSidebar"
import { SessionPanelToggle, TopBarControls } from "@/components/app-shell/TopBarControls"
import { AccountUsageBar } from "@/components/app-shell/AccountUsageBar"
import { LEFT_SIDEBAR_DEFAULT_WIDTH } from "@/components/app-shell/constants"
import { ProjectSidebar } from "@/components/project/ProjectSidebar"
import { EditorTabs } from "@/components/editor/EditorTabs"
import { ChatPanel } from "@/components/editor/ChatPanel"
import { DiffPreview } from "@/components/editor/DiffPreview"
import { TerminalTab } from "@/components/app-shell/content/TerminalTab"
import { ConversationEmptyState } from "@/components/ai-elements/conversation"
import { AppShell } from "@/components/app-shell/AppShell"
import { useGlobalShortcuts } from "@/lib/shortcuts/useGlobalShortcuts"
import { SettingsPage } from "@/components/settings/SettingsPage"
import { CronjobPage } from "@/components/cronjob/CronjobPage"
import { PluginsPage } from "@/components/plugins/PluginsPage"
import { BoardPage, type BoardPageView } from "@/components/channel/BoardPage"
import { SpecPage } from "@/components/spec/SpecPage"
import { CanvasPage } from "@/components/canvas-workflow/CanvasPage"
import { UpdateNotification } from "@/components/update/UpdateNotification"
import { InboxPage } from "@/components/inbox/InboxPage"
import { AssistantPage } from "@/components/assistant/AssistantPage"
import { useOpenWorkspaceSessions } from "@/hooks/useOpenWorkspaceSessions"
import { useInboxStream } from "@/hooks/useInboxStream"
import type { Notification } from "@/types/notification"
import { useAppShellStore } from "@/stores/app-shell-store"
import { useTabsStore } from "@/stores/tabs-store"
import { useThemeStore, applyTheme } from "@/stores/theme-store"
import { useEditorStore } from "@/stores/editor-store"
import { useProjectStore } from "@/stores/project-store"
import { useStreamingStore } from "@/stores/streaming-store"
import { trackEvent, syncAnalyticsIdentity, setAnalyticsScreen } from "@/lib/analytics"
import { api } from "@/lib/api"
import type { SpecChatRef } from '@shared/spec'
import { OPEN_PLUGINS_PAGE_EVENT, OPEN_SCHEDULE_PAGE_EVENT, OPEN_SETTINGS_EVENT, type OpenSettingsDetail } from "@/lib/open-settings"

export default function App() {
  const intl = useIntl()
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** Tab to land on when something deep-linked into Settings; cleared once consumed. */
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined)
  const [cronjobOpen, setCronjobOpen] = useState(false)
  const [pluginsOpen, setPluginsOpen] = useState(false)
  const [canvasOpen, setCanvasOpen] = useState(false)
  // Deep-link target when a task notification opens the board: forwarded to
  // BoardPage → TasksPage to open that task's detail. Cleared once consumed.
  const [boardInitialTaskId, setBoardInitialTaskId] = useState<number | null>(null)
  // These pages take over the workbench; Spec keeps its panels and chat surface.
  const [mainView, setMainView] = useState<'assistant' | 'inbox' | 'spec' | BoardPageView | null>(null)
  const [activeSpec, setActiveSpec] = useState<{ taskId: number; projectId: number } | null>(null)
  const [specChatIds, setSpecChatIds] = useState<ReadonlySet<string>>(() => new Set())
  const openSpec = useCallback((taskId: number, projectId: number) => {
    const currentTabId = useEditorStore.getState().activeTabId
    if (currentTabId) setSpecChatIds((previous) => previous.has(currentTabId) ? previous : new Set([...previous, currentTabId]))
    setActiveSpec({ taskId, projectId })
    setMainView('spec')
  }, [])
  const assistantOpen = mainView === 'assistant'
  const inboxOpen = mainView === 'inbox'
  const boardView = mainView === 'board' || mainView === 'channels' ? mainView : null
  // Each of those pages mounts the first time it's opened and then stays mounted, hidden while
  // another view is up, so coming back finds it as it was left (selected channel, scroll, filters).
  const [assistantMounted, setAssistantMounted] = useState(false)
  const [inboxMounted, setInboxMounted] = useState(false)
  // The Board page shows the view it was last on while hidden, so its inner state survives too.
  const [lastBoardView, setLastBoardView] = useState<BoardPageView | null>(null)
  if (assistantOpen && !assistantMounted) setAssistantMounted(true)
  if (inboxOpen && !inboxMounted) setInboxMounted(true)
  if (boardView !== null && boardView !== lastBoardView) setLastBoardView(boardView)
  const [sidebarWidth, setSidebarWidth] = useState(LEFT_SIDEBAR_DEFAULT_WIDTH)
  const theme = useThemeStore((state) => state.theme)
  const lightUITheme = useThemeStore((state) => state.lightUITheme)
  const darkUITheme = useThemeStore((state) => state.darkUITheme)
  const tabs = useEditorStore((state) => state.tabs)
  const activeTabId = useEditorStore((state) => state.activeTabId)
  const setActiveTab = useEditorStore((state) => state.setActiveTab)
  const closeTab = useEditorStore((state) => state.closeTab)
  const createChatTab = useEditorStore((state) => state.createChatTab)
  const createTerminalTab = useEditorStore((state) => state.createTerminalTab)
  const openChatTab = useEditorStore((state) => state.openChatTab)
  const setTabChatId = useEditorStore((state) => state.setTabChatId)
  const setWorkspace = useEditorStore((state) => state.setWorkspace)
  const workspaceStates = useEditorStore((state) => state.workspaceStates)
  const currentWorkspaceId = useEditorStore((state) => state.currentWorkspaceId)
  const canvasNavRequest = useEditorStore((state) => state.canvasNavigationRequest)
  const clearCanvasNavRequest = useEditorStore((state) => state.clearCanvasNavigationRequest)
  const taskNavRequest = useEditorStore((state) => state.taskNavigationRequest)
  const clearTaskNavRequest = useEditorStore((state) => state.clearTaskNavigationRequest)

  const projects = useProjectStore((state) => state.projects)
  const activeWorkspaceId = useProjectStore((state) => state.activeWorkspaceId)
  const loadProjects = useProjectStore((state) => state.loadProjects)
  const setActiveWorkspace = useProjectStore((state) => state.setActiveWorkspace)
  const streamingTabIds = useStreamingStore((s) => s.streamingTabIds)
  const rightPanelOpen = useAppShellStore((s) => s.rightPanelOpen)
  // Shell state, not App state: an expanded right panel needs to know whether
  // the sidebar left it sitting under the macOS traffic lights.
  const sidebarCollapsed = useAppShellStore((s) => s.sidebarCollapsed)
  const setSidebarCollapsed = useAppShellStore((s) => s.setSidebarCollapsed)
  const handleToggleSidebar = useAppShellStore((s) => s.toggleSidebar)

  const leaveMainView = useCallback(() => setMainView(null), [])
  const specFocusedTabId = useRef<string | null>(null)
  const openWorkspace = useCallback((workspaceId: number) => {
    void (async () => {
      await loadProjects()
      const project = useProjectStore.getState().projects.find((item) => item.workspaces.some((workspace) => workspace.id === workspaceId))
      if (!project) return
      setActiveWorkspace(workspaceId, project.id)
      setWorkspace(workspaceId, project.id)
      setMainView(null)
    })().catch((error: unknown) => console.error('Could not open workspace:', error))
  }, [loadProjects, setActiveWorkspace, setWorkspace])
  const focusSpecWorkspace = useCallback((workspaceId: number | null, projectId: number) => {
    setActiveWorkspace(workspaceId, projectId)
    setWorkspace(workspaceId, projectId)
    specFocusedTabId.current = useEditorStore.getState().activeTabId
  }, [setActiveWorkspace, setWorkspace])
  const focusSpecChat = useCallback((chat: SpecChatRef, projectId: number) => {
    focusSpecWorkspace(chat.workspaceId, projectId)
    const tabId = openChatTab(`chat:${chat.chatId}`, chat.title, undefined, chat.providerId ?? undefined, chat.subAgent || undefined)
    setTabChatId(tabId, chat.chatId)
    specFocusedTabId.current = tabId
    setSpecChatIds((previous) => previous.has(tabId) ? previous : new Set([...previous, tabId]))
  }, [focusSpecWorkspace, openChatTab, setTabChatId])
  // Switching to a tab from anywhere (Inbox, a card, a shortcut) means the
  // editor is wanted back, so it replaces the Assistant / Inbox view.
  const lastActiveTabIdRef = useRef(activeTabId)
  useEffect(() => {
    if (lastActiveTabIdRef.current === activeTabId) return
    lastActiveTabIdRef.current = activeTabId
    if (mainView !== 'spec' || activeTabId !== specFocusedTabId.current) setMainView(null)
  }, [activeTabId, mainView])

  // Keep the global inbox stream live for the whole session so the bell badge
  // updates even when the relevant chat/task tab is unmounted.
  useInboxStream()

  /**
   * Open a conversation in its workspace's editor: from the Inbox, or a card in the assistant.
   * `subAgent`: it is an agent's conversation (tp 'subagent'), which keeps the model it was given.
   */
  const openChat = useCallback(
    (target: { chatId: number; workspaceId?: number; title?: string; subAgent?: boolean }) => {
      setMainView(null)
      if (target.workspaceId != null) {
        const project = projects.find((p) => p.workspaces.some((w) => w.id === target.workspaceId))
        // Switch both stores before opening the tab. The project-store update
        // drives React asynchronously; waiting for the syncing effect would
        // otherwise open the conversation in the workspace we just left.
        setActiveWorkspace(target.workspaceId, project?.id)
        setWorkspace(target.workspaceId, project?.id ?? null)
      }
      const tabId = openChatTab(`chat:${target.chatId}`, target.title, undefined, undefined, target.subAgent || undefined)
      setTabChatId(tabId, target.chatId)
    },
    [projects, setActiveWorkspace, setWorkspace, openChatTab, setTabChatId],
  )

  // Deep-link from an inbox notification to its source (task board / workspace chat).
  const handleOpenNotification = useCallback(
    (n: Notification) => {
      // The assistant's rows have no chat or task to land on: they open its page.
      if (n.kind === 'assistant_message' || n.kind === 'assistant_approval') {
        setMainView('assistant')
        return
      }
      // Also when the source is the tab already active: no tab change would bring the editor back.
      setMainView(null)
      if (n.taskId != null) {
        setBoardInitialTaskId(n.taskId)
        setMainView('board')
        return
      }
      if (n.chatId != null) openChat({ chatId: n.chatId, workspaceId: n.workspaceId ?? undefined, title: n.title })
    },
    [openChat],
  )

  // Browser Use: let the main-process IAB backend open/close browser tabs.
  // The tabs store only exists here, so main has to ask us. See
  // src/components/browser/browser-use-bridge.ts.
  useEffect(() => installBrowserUseBridge(), [])

  // Every keyboard shortcut in the app, dispatched from one command table
  // (src/lib/shortcuts/commands.ts) so Settings → Keyboard shortcuts can rebind
  // them. Panel toggles, new-tab shortcuts and ⌘W all live there.
  useGlobalShortcuts()

  const handleProviderSelected = useCallback((providerId: string) => {
    createChatTab(providerId, "Chat")
  }, [createChatTab])

  const activeWorkspaceInfo = useMemo(() => {
    if (!activeWorkspaceId) return null
    for (const project of projects) {
      const workspace = project.workspaces.find(w => w.id === activeWorkspaceId)
      if (workspace) {
        return { project, workspace }
      }
    }
    return null
  }, [projects, activeWorkspaceId])

  const handleNewTerminal = useCallback((providerId: string, label: string) => {
    const launch = TERMINAL_CLI_LAUNCH[providerId]
    if (!launch) return
    createTerminalTab({
      providerId,
      launch,
      cwd: activeWorkspaceInfo?.workspace.worktreePath,
      title: label,
    })
  }, [createTerminalTab, activeWorkspaceInfo])

  // Each workspace keeps its own panel/tab state. Switch the live bucket when
  // the active workspace changes (codex-style per-project sidebar): leaving a
  // project parks its tabs, returning restores them, a fresh project is empty.
  useEffect(() => {
    useTabsStore
      .getState()
      .setActiveWorkspace(activeWorkspaceId != null ? String(activeWorkspaceId) : null)
  }, [activeWorkspaceId])

  // Deep links into Settings (a plugin row in the session panel, an extension row…).
  useEffect(() => {
    const onOpen = (event: Event): void => {
      const detail = (event as CustomEvent<OpenSettingsDetail>).detail
      if (!detail?.tab) return
      setSettingsTab(detail.tab)
      setSettingsOpen(true)
      trackEvent('page_opened', { page: 'settings' })
    }
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen)
  }, [])

  // Deep links into the Plugins page (a plugin-provided skill or MCP server, a session-panel row…).
  // It stacks over Settings when opened from there, so Back lands where the user came from.
  useEffect(() => {
    const onOpen = (): void => {
      setPluginsOpen(true)
      trackEvent('page_opened', { page: 'plugins' })
    }
    window.addEventListener(OPEN_PLUGINS_PAGE_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_PLUGINS_PAGE_EVENT, onOpen)
  }, [])

  // A schedule card in a chat opens the Schedule page on the task it created.
  useEffect(() => {
    const onOpen = (): void => {
      setCronjobOpen(true)
      trackEvent('page_opened', { page: 'cronjob' })
    }
    window.addEventListener(OPEN_SCHEDULE_PAGE_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_SCHEDULE_PAGE_EVENT, onOpen)
  }, [])

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0],
    [tabs, activeTabId]
  )

  // The editor tab strip never shows side chats — they belong to the right-panel
  // tab that opened them.
  const editorStripTabs = useMemo(() => tabs.filter((tab) => !tab.isSideChat), [tabs])

  // Keep Spec conversations mounted across workspace switches so the original
  // chat, draft and live stream remain the same surface through both entrances.
  const allChatTabs = useMemo(() => {
    const currentKey = String(currentWorkspaceId ?? 'global')
    // Side chats render inside their right-panel tab, not here.
    const currentChatTabs = tabs.filter(t => t.type === 'chat' && !t.isSideChat)
    const currentIds = new Set(currentChatTabs.map(t => t.id))

    const inactiveTabs: typeof tabs = []
    for (const [key, state] of Object.entries(workspaceStates)) {
      if (key === currentKey) continue
      for (const tab of state.tabs) {
        if (tab.type === 'chat' && !tab.isSideChat && !currentIds.has(tab.id) && (streamingTabIds.has(tab.id) || specChatIds.has(tab.id))) {
          inactiveTabs.push(tab)
        }
      }
    }

    return [...currentChatTabs, ...inactiveTabs]
  }, [tabs, workspaceStates, currentWorkspaceId, streamingTabIds, specChatIds])

  useEffect(() => {
    void loadProjects().catch((error) => {
      console.error("Failed to load projects:", error)
    })
  }, [loadProjects])



  // Apply theme on mount and when theme or UI preset changes
  useEffect(() => {
    applyTheme(theme)

    // Listen for system theme changes
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
    const handleChange = () => {
      if (theme === "system") {
        applyTheme("system")
      }
    }
    mediaQuery.addEventListener("change", handleChange)
    return () => mediaQuery.removeEventListener("change", handleChange)
  }, [theme, lightUITheme, darkUITheme])

  // Sync active workspace with editor store
  useEffect(() => {
    // Determine activeProjectId. 
    // Usually activeWorkspaceId implies a project, but we want to pass the explicit project ID if available.
    // We can find the project that contains the active workspace.
    // However, project-store keeps activeProjectId. Let's iterate projects to be safe or use activeProjectId if it aligns.
    // Actually, App.tsx already computes activeWorkspaceInfo which has project.

    let projectId = null
    if (activeWorkspaceId) {
      const found = projects.find(p => p.workspaces.some(w => w.id === activeWorkspaceId))
      if (found) projectId = found.id
    }

    setWorkspace(activeWorkspaceId, projectId)
  }, [activeWorkspaceId, projects, setWorkspace])

  // Agent sessions the server started in this workspace (a dispatched task) get a tab.
  useOpenWorkspaceSessions(currentWorkspaceId)

  // Handle Chat → Canvas navigation request from editor-store
  useEffect(() => {
    if (canvasNavRequest) {
      setCanvasOpen(true)
      clearCanvasNavRequest()
    }
  }, [canvasNavRequest, clearCanvasNavRequest])

  // A task card in a chat transcript asked to open that task — same landing as an
  // inbox task notification: the board, detail open.
  useEffect(() => {
    if (!taskNavRequest) return
    setBoardInitialTaskId(taskNavRequest.taskId)
    setMainView('board')
    clearTaskNavRequest()
  }, [taskNavRequest, clearTaskNavRequest])

  // Bind analytics to the broker account this desktop client is signed into, so
  // its events reconcile with the same person's web and phone sessions. The web
  // build does this in WebAuthGate, where the token is local; here the token
  // lives server-side and only /saas/status can answer. Failing (server still
  // starting, not signed in) just leaves the client anonymous — SaasSettings
  // syncs again whenever the user opens it.
  useEffect(() => {
    if (__APP_TARGET__ === 'web') return
    void api.saasGetStatus()
      .then((s) => syncAnalyticsIdentity(s.connected ? s.userId ?? null : null))
      .catch(() => {})
  }, [])

  const isPageOpen = settingsOpen || pluginsOpen || canvasOpen || cronjobOpen

  // The app navigates by state, not by URL, so analytics has no way to know
  // which screen the user is on unless it is told. Full-screen pages win over
  // the tab underneath them because that is what the user is looking at.
  const analyticsScreen = pluginsOpen ? 'plugins'
    : settingsOpen ? 'settings'
    : canvasOpen ? 'canvas'
    : cronjobOpen ? 'cronjob'
    : inboxOpen ? 'inbox'
    : assistantOpen ? 'assistant'
    : mainView === 'spec' ? 'spec'
    : boardView ? boardView
    : activeTab?.type ?? 'home'
  useEffect(() => { setAnalyticsScreen(analyticsScreen) }, [analyticsScreen])

  return (
    <>
      {/* Browser annotations ride on the Electron <webview>; the web build has no
          browser tab, so its frameless editor window has nothing to drive. */}
      {__APP_TARGET__ !== 'web' && <AnnotationEditorHost />}
      {/* Full-screen pages portal to body so they become siblings of the
          browser webview container (also body-level, z-40) and cover it via
          normal z-index. Inside #root they'd render *under* the webview. */}
      {createPortal(
        <>
          {settingsOpen && (
            <div className="fixed inset-0 z-50">
              <SettingsPage
                initialTab={settingsTab}
                onBack={() => { setSettingsOpen(false); setSettingsTab(undefined); trackEvent('page_closed', { page: 'settings' }) }}
              />
            </div>
          )}

          {pluginsOpen && (
            <div className="fixed inset-0 z-50">
              <PluginsPage onBack={() => { setPluginsOpen(false); trackEvent('page_closed', { page: 'plugins' }) }} />
            </div>
          )}

          {canvasOpen && (
            <div className="fixed inset-0 z-50">
              <CanvasPage
                onBack={() => setCanvasOpen(false)}
                onOpenChat={(chatId, title, providerId) => {
                  setCanvasOpen(false)
                  const tabId = `chat:${chatId}`
                  openChatTab(tabId, title, undefined, providerId)
                  setTabChatId(tabId, chatId)
                }}
              />
            </div>
          )}

          {cronjobOpen && (
            <div className="fixed inset-0 z-50">
              <CronjobPage
                onBack={() => setCronjobOpen(false)}
                onOpenChat={(chatId, title, providerId) => {
                  setCronjobOpen(false)
                  const tabId = `chat:${chatId}`
                  openChatTab(tabId, title, undefined, providerId)
                  setTabChatId(tabId, chatId)
                }}
              />
            </div>
          )}

          {/* Toasts live at body level, above the full-screen pages. They used to
              sit inside the shell below, which goes `invisible` whenever a page is
              open — so every error raised from Settings / Tasks / Inbox was
              rendered and then hidden, and the action just looked like it silently
              reverted. */}
          <Toaster position="bottom-right" closeButton theme={theme} />
        </>,
        document.body
      )}

    <div className={`relative h-screen w-screen flex flex-col text-foreground overflow-hidden bg-background ${isPageOpen ? 'invisible' : ''}`}>
      <UpdateNotification />

      {/* Main Content */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="flex h-full w-full min-h-0">
          {/* Left Panel - Project Sidebar (push-open, mirrors RightPanel) */}
          <LeftSidebar
            isOpen={!sidebarCollapsed}
            width={sidebarWidth}
            onWidthChange={setSidebarWidth}
            onClose={() => setSidebarCollapsed(true)}
          >
            <ProjectSidebar
              onOpenSettings={() => { setSettingsOpen(true); trackEvent('page_opened', { page: 'settings' }) }}
              onOpenCronjobs={() => { setCronjobOpen(true); trackEvent('page_opened', { page: 'cronjob' }) }}
              onOpenPlugins={() => { setPluginsOpen(true); trackEvent('page_opened', { page: 'plugins' }) }}
              onOpenCanvas={() => { setCanvasOpen(true); trackEvent('page_opened', { page: 'canvas' }) }}
              onOpenBoard={() => { setMainView('board'); trackEvent('page_opened', { page: 'board' }) }}
              onOpenChannels={() => { setMainView('channels'); trackEvent('page_opened', { page: 'channels' }) }}
              onOpenInbox={() => { setMainView('inbox'); trackEvent('page_opened', { page: 'inbox' }) }}
              onOpenAssistant={() => setMainView('assistant')}
              assistantActive={assistantOpen}
              inboxActive={inboxOpen}
              boardActive={mainView === 'board'}
              channelsActive={mainView === 'channels'}
              onLeaveMainView={leaveMainView}
              activeSpecId={mainView === 'spec' ? activeSpec?.taskId : null}
              onOpenSpec={openSpec}
              onCollapse={handleToggleSidebar}
              collapsed={sidebarCollapsed}
            />
          </LeftSidebar>

          {/* Main Content Area (Center + Right) */}
          <div className="flex flex-1 flex-col min-h-0 min-w-0 bg-background">
            {/* The Assistant, the Inbox and the Board take over center + right. Like the editor,
                each stays mounted once opened (display:none while another view is up), so
                switching back keeps its state; the browser webview hides itself once its
                placeholder has no size. */}
            {assistantMounted && (
              <div className={cn("flex min-h-0 flex-1 flex-col", !assistantOpen && "hidden")}>
                <PageVisibleContext value={assistantOpen}>
                  <AssistantPage sidebarCollapsed={sidebarCollapsed} onExpandSidebar={handleToggleSidebar} onOpenChat={openChat} />
                </PageVisibleContext>
              </div>
            )}
            {inboxMounted && (
              <div className={cn("flex min-h-0 flex-1 flex-col", !inboxOpen && "hidden")}>
                <PageVisibleContext value={inboxOpen}>
                  <InboxPage
                    sidebarCollapsed={sidebarCollapsed}
                    onExpandSidebar={handleToggleSidebar}
                    onOpenSource={handleOpenNotification}
                  />
                </PageVisibleContext>
              </div>
            )}
            {/* One instance for both entries, so switching between them keeps the loaded data and filter. */}
            {lastBoardView && (
              <div className={cn("flex min-h-0 flex-1 flex-col", boardView === null && "hidden")}>
                <PageVisibleContext value={boardView !== null}>
                  <BoardPage
                    view={lastBoardView}
                    onViewChange={setMainView}
                    sidebarCollapsed={sidebarCollapsed}
                    onExpandSidebar={handleToggleSidebar}
                    initialTaskId={boardInitialTaskId}
                    onInitialTaskConsumed={() => setBoardInitialTaskId(null)}
                    onOpenChat={(chat) =>
                      openChat({
                        chatId: chat.chatId,
                        workspaceId: chat.workspaceId ?? undefined,
                        title: chat.title,
                        subAgent: chat.subAgent || undefined,
                      })
                    }
                    onOpenWorkspace={(workspaceId) => {
                      setMainView(null)
                      // The workspace was likely just provisioned by a task dispatch
                      // and isn't in the store yet — reload, then read the *fresh*
                      // state to locate and activate it.
                      void (async () => {
                        await loadProjects()
                        const found = useProjectStore
                          .getState()
                          .projects.find((p) => p.workspaces.some((w) => w.id === workspaceId))
                        if (found) setActiveWorkspace(workspaceId, found.id)
                      })()
                    }}
                  />
                </PageVisibleContext>
              </div>
            )}
            <div className={cn("flex min-h-0 flex-1 flex-col", mainView !== null && mainView !== 'spec' && "hidden")}>
            <PageVisibleContext value={!isPageOpen && (mainView === null || mainView === 'spec')}>
            <AppShell>
              <SpecPage
                target={mainView === 'spec' ? activeSpec : null}
                sidebarCollapsed={sidebarCollapsed}
                onExpandSidebar={handleToggleSidebar}
                onOpenWorkspace={openWorkspace}
                onFocusWorkspace={focusSpecWorkspace}
                onFocusChat={focusSpecChat}
                workspaceHeader={<>
                {/* Center header (workspace breadcrumbs). The whole row is a
                    drag-region so its empty space drags the window; the inline
                    TopBarControls are `no-drag` children (macOS honors that for
                    real children of a drag bar). When the right panel is open
                    the controls move into its tab strip (window top-right), so
                    we only render them here when it's closed. */}
                <div className="@container/topbar drag-region h-10 flex items-center border-b border-border/50 bg-background shrink-0">
                  <div className={cn("flex flex-1 min-w-0 items-center gap-2 text-xs text-muted-foreground font-normal", sidebarCollapsed ? (__APP_TARGET__ === 'web' ? "px-4" : "pl-20 pr-4") : "px-4")}>
                    {sidebarCollapsed && (
                      <button
                        className="no-drag flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:bg-accent-hover hover:text-foreground transition-colors"
                        style={{ viewTransitionName: "sidebar-trigger" }}
                        onClick={handleToggleSidebar}
                        title={intl.formatMessage({ id: "app.expandSidebar", defaultMessage: "Expand sidebar" })}
                      >
                        <PanelLeft className="h-4 w-4" />
                      </button>
                    )}
                    {/* Both names truncate: without it the workspace pill wraps
                        onto a second line, outgrows the h-10 row and collides with
                        whatever sits to its right. The project name gives way first
                        — the workspace is the more specific half of the crumb. */}
                    <span className="min-w-0 shrink truncate hover:text-tint transition-colors cursor-pointer no-drag">
                      {activeWorkspaceInfo ? activeWorkspaceInfo.project.name : "OPERON"}
                    </span>
                    {activeWorkspaceInfo && (
                      <>
                        <span className="shrink-0 text-muted-foreground/40">›</span>
                        <span className="min-w-0 shrink-[0.5] truncate hover:text-foreground/90 transition-colors cursor-pointer no-drag bg-muted/50 px-1.5 py-0.5 rounded-md text-xs">
                          {activeWorkspaceInfo.workspace.name}
                        </span>
                      </>
                    )}
                  </div>
                  {/* Account quota for every signed-in provider. A real child
                      of the drag row (not a floating overlay) so macOS honors
                      its `no-drag`; it sits before the panel toggles because it
                      is read, not operated. */}
                  {/* Refresh, Session and the panel toggles read as one row of
                      24px buttons 2px apart (as in the right panel's strip). */}
                  <AccountUsageBar className="shrink-0 pr-0.5" />
                  <SessionPanelToggle className={rightPanelOpen ? "mr-2" : "mr-0.5"} />
                  {/* When the right panel is closed this row is the window's
                      top-right, so the controls live here; when it's open they
                      move into the right panel's tab strip instead. */}
                  {!rightPanelOpen && (
                    <div className="shrink-0 pr-2">
                      <TopBarControls />
                    </div>
                  )}
                </div>

                <EditorTabs
                  tabs={editorStripTabs}
                  activeTabId={activeTabId}
                  onSelectTab={setActiveTab}
                  onCloseTab={closeTab}
                  onNewChat={handleProviderSelected}
                  onNewTerminal={handleNewTerminal}
                  onOpenChat={openChatTab}
                />
                </>}
              >
                <div className="relative min-h-0 flex-1 overflow-hidden">
                  {/* Render chat tabs from ALL workspaces to keep streaming
                      alive across workspace switches */}
                  {allChatTabs.map(tab => {
                    const isActive = activeTabId === tab.id;
                    return (
                      <div
                        key={tab.id}
                        className="absolute inset-0 bg-background"
                        aria-hidden={!isActive}
                        inert={!isActive}
                        style={{
                          opacity: isActive ? 1 : 0,
                          zIndex: isActive ? 1 : 0,
                          pointerEvents: isActive ? 'auto' : 'none',
                        }}
                      >
                        <ChatPanel
                          chatId={tab.id}
                          providerId={tab.providerId}
                          visible={isActive && !isPageOpen}
                        />
                      </div>
                    );
                  })}
                  {activeTab?.type === "diff" && activeTab.filePath && (
                    <div className="absolute inset-0 z-10 bg-background">
                      <DiffPreview
                        path={activeTab.filePath}
                        content={activeTab.content ?? ""}
                      />
                    </div>
                  )}
                  {activeTab?.type === "terminal" && activeTab.terminalId && (
                    <div className="absolute inset-0 z-10 bg-background">
                      <TerminalTab
                        terminalId={activeTab.terminalId}
                        cwd={activeTab.cwd ?? ""}
                        launch={activeTab.launch}
                        isActive={!isPageOpen && mainView === null}
                      />
                    </div>
                  )}
                  {!activeTab && (
                    <ConversationEmptyState className="bg-background" style={{ backgroundImage: 'var(--gradient-glow)' }}>
                      <div className="flex flex-col items-center justify-center h-full text-center space-y-6 pb-20 select-none">
                        <svg width="80" height="80" viewBox="60 90 900 850" fill="none" xmlns="http://www.w3.org/2000/svg" className="opacity-90 relative z-10 drop-shadow-[0_0_24px_rgba(99,88,220,0.2)]">
                          <path className="fill-brand" d="M312.607 320.213c7.186-11.909 22.72-15.771 34.696-8.626l120.42 71.849C475.34 387.981 480 396.167 480 405s-4.66 17.019-12.277 21.564l-120.42 71.849c-11.976 7.145-27.51 3.283-34.696-8.626s-3.301-27.357 8.674-34.502L405.559 405l-84.278-50.285c-11.975-7.145-15.859-22.593-8.674-34.502M714.859 631C728.744 631 740 642.193 740 656s-11.256 25-25.141 25H595.141C581.256 681 570 669.807 570 656s11.256-25 25.141-25z" />
                          <path className="fill-brand" d="M836 512c0-178.94-145.06-324-324-324S188 333.06 188 512s145.06 324 324 324v96C280.04 932 92 743.96 92 512S280.04 92 512 92s420 188.04 420 420-188.04 420-420 420v-96c178.94 0 324-145.06 324-324" />
                          <path className="fill-brand" d="M380.374 146c129.287 0 234.094 104.902 234.094 234.306 0 64.118-25.736 122.214-67.426 164.521-25.545 25.077-41.574 60.224-41.574 98.867 0 76.315 61.81 138.18 138.056 138.18 38.607 0 73.511-15.863 98.566-41.431l67.91 67.97C767.564 851.376 708.652 878 643.524 878 514.237 878 409.43 773.098 409.43 643.694c0-65.187 26.778-124.365 69.702-166.839 24.311-24.909 39.298-58.976 39.298-96.549 0-76.315-61.81-138.18-138.056-138.18-37.538 0-71.576 14.998-96.462 39.331L216 213.484C258.268 171.756 316.315 146 380.374 146" />
                        </svg>
                        <h1 className="relative z-10 text-4xl text-foreground/90">
                          <span className="logo text-foreground uppercase">
                            OPERON
                          </span>
                        </h1>
                        <div className="absolute inset-0 bg-grid-black/[0.02] dark:bg-grid-white/[0.02] z-0 pointer-events-none [mask-image:radial-gradient(ellipse_at_center,transparent_20%,black)]"></div>
                      </div>
                    </ConversationEmptyState>
                  )}
                </div>
              </SpecPage>
            </AppShell>
            </PageVisibleContext>
            </div>
          </div>
        </div>
      </div>
    </div>

    </>
  )
}
