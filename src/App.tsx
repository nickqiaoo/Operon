import { useCallback, useEffect, useMemo, useState } from "react"
import { installBrowserUseBridge } from "@/components/browser/browser-use-bridge"
import { useIntl } from "react-intl"
import { PanelLeft } from "lucide-react"
import { cn } from "@/lib/utils"
import { Toaster } from "sonner"
import { TERMINAL_CLI_LAUNCH } from "@/lib/terminal-clis"
import { createPortal } from "react-dom"
import { AnnotationEditorHost } from "@/components/browser/AnnotationEditorHost"

import { LeftSidebar } from "@/components/app-shell/LeftSidebar"
import { TopBarControls } from "@/components/app-shell/TopBarControls"
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
import { SkillPage } from "@/components/skill/SkillPage"
import { ChannelPage } from "@/components/channel/ChannelPage"
import { CanvasPage } from "@/components/canvas-workflow/CanvasPage"
import { UpdateNotification } from "@/components/update/UpdateNotification"
import { InboxPage } from "@/components/inbox/InboxPage"
import { useInboxStream } from "@/hooks/useInboxStream"
import { useComputerUsePIPHostLayout } from "@/hooks/useComputerUsePIPHostLayout"
import { useComputerUsePermissionAlert } from "@/hooks/useComputerUsePermissionAlert"
import type { Notification } from "@/types/notification"
import { useAppShellStore } from "@/stores/app-shell-store"
import { useTabsStore } from "@/stores/tabs-store"
import { useThemeStore, applyTheme } from "@/stores/theme-store"
import { useEditorStore } from "@/stores/editor-store"
import { useProjectStore } from "@/stores/project-store"
import { useStreamingStore } from "@/stores/streaming-store"
import { trackEvent, syncAnalyticsIdentity, setAnalyticsScreen } from "@/lib/analytics"
import { api } from "@/lib/api"
import { OPEN_SETTINGS_EVENT, type OpenSettingsDetail } from "@/lib/open-settings"

export default function App() {
  const intl = useIntl()
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** Tab to land on when something deep-linked into Settings; cleared once consumed. */
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined)
  const [cronjobOpen, setCronjobOpen] = useState(false)
  const [skillOpen, setSkillOpen] = useState(false)
  const [canvasOpen, setCanvasOpen] = useState(false)
  const [channelProject, setChannelProject] = useState<{ id: number; name: string } | null>(null)
  // Deep-link target when a task notification opens the channel page: forwarded
  // to ChannelPage → TasksPage to open that task's detail. Cleared once consumed.
  const [channelInitialTaskId, setChannelInitialTaskId] = useState<number | null>(null)
  const [inboxOpen, setInboxOpen] = useState(false)
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

  // Keep the global inbox stream live for the whole session so the bell badge
  // updates even when the relevant chat/task tab is unmounted.
  useInboxStream()

  // Deep-link from an inbox notification to its source (task board / workspace chat).
  const handleOpenNotification = useCallback(
    (n: Notification) => {
      setInboxOpen(false)
      if (n.taskId != null && n.projectId != null) {
        const project = projects.find((p) => p.id === n.projectId)
        if (project) {
          setChannelInitialTaskId(n.taskId)
          setChannelProject({ id: project.id, name: project.name })
        }
        return
      }
      if (n.chatId != null) {
        const project =
          n.workspaceId != null
            ? projects.find((p) => p.workspaces.some((w) => w.id === n.workspaceId))
            : undefined
        if (n.workspaceId != null) {
          // Switch both stores before opening the tab. The project-store update
          // drives React asynchronously; waiting for the syncing effect would
          // otherwise open the Inbox conversation in the workspace we just left.
          setActiveWorkspace(n.workspaceId, project?.id)
          setWorkspace(n.workspaceId, project?.id ?? null)
        }
        const tabId = `chat:${n.chatId}`
        openChatTab(tabId, n.title)
        setTabChatId(tabId, n.chatId)
      }
    },
    [projects, setActiveWorkspace, setWorkspace, openChatTab, setTabChatId],
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

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0],
    [tabs, activeTabId]
  )

  // The editor tab strip never shows side chats — they belong to the right-panel
  // tab that opened them.
  const editorStripTabs = useMemo(() => tabs.filter((tab) => !tab.isSideChat), [tabs])

  // Collect chat tabs from current workspace + actively streaming tabs from other workspaces.
  // Only streaming inactive tabs stay mounted to preserve their SSE connections.
  // Non-streaming inactive tabs are unmounted and reload history from DB when revisited.
  const allChatTabs = useMemo(() => {
    const currentKey = String(currentWorkspaceId ?? 'global')
    // Side chats render inside their right-panel tab, not here.
    const currentChatTabs = tabs.filter(t => t.type === 'chat' && !t.isSideChat)
    const currentIds = new Set(currentChatTabs.map(t => t.id))

    const inactiveTabs: typeof tabs = []
    for (const [key, state] of Object.entries(workspaceStates)) {
      if (key === currentKey) continue
      for (const tab of state.tabs) {
        if (tab.type === 'chat' && !tab.isSideChat && !currentIds.has(tab.id) && streamingTabIds.has(tab.id)) {
          inactiveTabs.push(tab)
        }
      }
    }

    return [...currentChatTabs, ...inactiveTabs]
  }, [tabs, workspaceStates, currentWorkspaceId, streamingTabIds])

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

  // Handle Chat → Canvas navigation request from editor-store
  useEffect(() => {
    if (canvasNavRequest) {
      setCanvasOpen(true)
      clearCanvasNavRequest()
    }
  }, [canvasNavRequest, clearCanvasNavRequest])

  // A task card in a chat transcript asked to open that task — same landing as an
  // inbox task notification: the project's channel page, Tasks view, detail open.
  useEffect(() => {
    if (!taskNavRequest) return
    const project = projects.find((p) => p.id === taskNavRequest.projectId)
    if (project) {
      setChannelInitialTaskId(taskNavRequest.taskId)
      setChannelProject({ id: project.id, name: project.name })
    }
    clearTaskNavRequest()
  }, [taskNavRequest, clearTaskNavRequest, projects])

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

  const isPageOpen = settingsOpen || skillOpen || canvasOpen || cronjobOpen || !!channelProject || inboxOpen

  // The app navigates by state, not by URL, so analytics has no way to know
  // which screen the user is on unless it is told. Full-screen pages win over
  // the tab underneath them because that is what the user is looking at.
  const analyticsScreen = settingsOpen ? 'settings'
    : skillOpen ? 'skill'
    : canvasOpen ? 'canvas'
    : cronjobOpen ? 'cronjob'
    : inboxOpen ? 'inbox'
    : channelProject ? 'channel'
    : activeTab?.type ?? 'home'
  useEffect(() => { setAnalyticsScreen(analyticsScreen) }, [analyticsScreen])
  const activeComputerUseHostSessionID = !isPageOpen && activeTab?.type === 'chat' && activeTab.chatId != null
    ? String(activeTab.chatId)
    : undefined
  useComputerUsePIPHostLayout(activeComputerUseHostSessionID)
  useComputerUsePermissionAlert()

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

          {skillOpen && (
            <div className="fixed inset-0 z-50">
              <SkillPage onBack={() => { setSkillOpen(false); trackEvent('page_closed', { page: 'skill' }) }} />
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
                workspaceId={activeWorkspaceId ?? undefined}
                // The page covers the rail that would otherwise show which
                // workspace is active, and its list is filtered by that id.
                workspaceLabel={
                  activeWorkspaceInfo
                    ? `${activeWorkspaceInfo.project.name} / ${activeWorkspaceInfo.workspace.name}`
                    : null
                }
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

          {channelProject && (
            <div className="fixed inset-0 z-50">
              <ChannelPage
                projectId={channelProject.id}
                projectName={channelProject.name}
                initialTaskId={channelInitialTaskId}
                onInitialTaskConsumed={() => setChannelInitialTaskId(null)}
                onBack={() => {
                  setChannelProject(null)
                  setChannelInitialTaskId(null)
                  // A task dispatch may have provisioned a new workspace while we
                  // were in the channel view; re-sync so the home sidebar lists it.
                  void loadProjects()
                }}
                onOpenWorkspace={(workspaceId) => {
                  setChannelProject(null)
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
            </div>
          )}

          {inboxOpen && (
            <div className="fixed inset-0 z-50">
              <InboxPage onBack={() => setInboxOpen(false)} onOpenSource={handleOpenNotification} />
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
              onOpenSkills={() => { setSkillOpen(true); trackEvent('page_opened', { page: 'skill' }) }}
              onOpenCanvas={() => { setCanvasOpen(true); trackEvent('page_opened', { page: 'canvas' }) }}
              onOpenChannel={(project) => setChannelProject({ id: project.id, name: project.name })}
              onOpenInbox={() => { setInboxOpen(true); trackEvent('page_opened', { page: 'inbox' }) }}
              onCollapse={handleToggleSidebar}
              collapsed={sidebarCollapsed}
            />
          </LeftSidebar>

          {/* Main Content Area (Center + Right) */}
          <div className="flex flex-1 flex-col min-h-0 min-w-0 bg-background">
            <AppShell>
              <div className="flex h-full min-h-0 flex-col">
                {/* Center header (workspace breadcrumbs). The whole row is a
                    drag-region so its empty space drags the window; the inline
                    TopBarControls are `no-drag` children (macOS honors that for
                    real children of a drag bar). When the right panel is open
                    the controls move into its tab strip (window top-right), so
                    we only render them here when it's closed. */}
                <div className="drag-region h-10 flex items-center border-b border-border/60 bg-background shrink-0">
                  <div className={cn("flex flex-1 min-w-0 items-center gap-2 text-xs text-muted-foreground font-normal", sidebarCollapsed ? (__APP_TARGET__ === 'web' ? "px-4" : "pl-20 pr-4") : "px-4")}>
                    {sidebarCollapsed && (
                      <button
                        className="no-drag flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
                        style={{ viewTransitionName: "sidebar-trigger" }}
                        onClick={handleToggleSidebar}
                        title={intl.formatMessage({ id: "app.expandSidebar", defaultMessage: "Expand sidebar" })}
                      >
                        <PanelLeft className="h-4 w-4" />
                      </button>
                    )}
                    <span className="flex items-center gap-1 hover:text-tint transition-colors cursor-pointer no-drag">
                      {activeWorkspaceInfo ? activeWorkspaceInfo.project.name : "OPERON"}
                    </span>
                    {activeWorkspaceInfo && (
                      <>
                        <span className="text-muted-foreground/40">›</span>
                        <span className="flex items-center gap-1 hover:text-foreground/90 transition-colors cursor-pointer no-drag bg-muted/50 px-1.5 py-0.5 rounded-md text-xs">
                          {activeWorkspaceInfo.workspace.name}
                        </span>
                      </>
                    )}
                  </div>
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
                <div className="relative min-h-0 flex-1 overflow-hidden">
                  {/* Render chat tabs from ALL workspaces to keep streaming
                      alive across workspace switches */}
                  {allChatTabs.map(tab => {
                    const isActive = activeTabId === tab.id;
                    return (
                      <div
                        key={tab.id}
                        data-computer-use-pip-host={isActive && tab.chatId != null ? String(tab.chatId) : undefined}
                        className="absolute inset-0 bg-background"
                        aria-hidden={!isActive}
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
                        isActive={!isPageOpen}
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
              </div>
            </AppShell>
          </div>
        </div>
      </div>
    </div>

    </>
  )
}
