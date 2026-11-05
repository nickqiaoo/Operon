import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { installBrowserUseBridge } from "@/components/browser/browser-use-bridge"
import { cn } from "@/lib/utils"
import { Toaster } from "sonner"
import { TERMINAL_CLI_LAUNCH } from "@/lib/terminal-clis"
import { createPortal } from "react-dom"
import { Z_FULL_PAGE } from "@/lib/z-index"
import { AnnotationEditorHost } from "@/components/browser/AnnotationEditorHost"

import { AppSidebar, SidebarToggle } from "@/components/app-shell/AppSidebar"
import { KeepAliveView } from "@/components/app-shell/KeepAliveView"
import { SessionPanelToggle, TopBarControls } from "@/components/app-shell/TopBarControls"
import { AccountUsageBar } from "@/components/app-shell/AccountUsageBar"
import { EditorTabs } from "@/components/editor/EditorTabs"
import { ChatPanel } from "@/components/editor/ChatPanel"
import { TerminalTab } from "@/components/app-shell/content/TerminalTab"
import { ConversationEmptyState } from "@/components/ai-elements/conversation"
import { AppShell } from "@/components/app-shell/AppShell"
import { useGlobalShortcuts } from "@/lib/shortcuts/useGlobalShortcuts"
import { SettingsPage } from "@/components/settings/SettingsPage"
import { CronjobPage } from "@/components/cronjob/CronjobPage"
import { PluginsPage } from "@/components/plugins/PluginsPage"
import { BoardPage } from "@/components/channel/BoardPage"
import { SpecPage } from "@/components/spec/SpecPage"
import { CanvasPage } from "@/components/canvas-workflow/CanvasPage"
import { InboxPage } from "@/components/inbox/InboxPage"
import { AssistantPage } from "@/components/assistant/AssistantPage"
import { useOpenWorkspaceSessions } from "@/hooks/useOpenWorkspaceSessions"
import { useUpdateNotifications } from "@/hooks/useUpdateNotifications"
import { useInboxStream } from "@/hooks/useInboxStream"
import { useTaskStream } from "@/hooks/useTaskStream"
import type { Notification } from "@/types/notification"
import { useAppShellStore } from "@/stores/app-shell-store"
import { useTabsStore } from "@/stores/tabs-store"
import { useThemeStore, applyTheme } from "@/stores/theme-store"
import { useEditorStore } from "@/stores/editor-store"
import { useProjectStore } from "@/stores/project-store"
import { useStreamingStore } from "@/stores/streaming-store"
import { useNavigationStore, type FullPage, type FullPageKind } from "@/stores/navigation-store"
import { trackEvent, syncAnalyticsIdentity, setAnalyticsScreen } from "@/lib/analytics"
import { api } from "@/lib/api"
import type { SpecChatRef } from '@shared/spec'

/** Full-screen pages in the order they are rendered; which is on top comes from the stack, by z-index. */
const FULL_PAGE_ORDER: readonly FullPageKind[] = ["settings", "plugins", "canvas", "schedule"]
/** Their names in analytics (the Schedule page predates its name). */
const FULL_PAGE_ANALYTICS = { settings: "settings", plugins: "plugins", canvas: "canvas", schedule: "cronjob" } as const satisfies Record<FullPageKind, string>

export default function App() {
  useTaskStream()
  // Where the shell is: see navigation-store.ts.
  const mainView = useNavigationStore((s) => s.main)
  const pages = useNavigationStore((s) => s.pages)
  const visited = useNavigationStore((s) => s.visited)
  const lastBoardView = useNavigationStore((s) => s.lastBoardView)
  const boardTaskId = useNavigationStore((s) => s.boardTaskId)
  const showMain = useNavigationStore((s) => s.showMain)
  const showWorkbench = useNavigationStore((s) => s.showWorkbench)
  const openTask = useNavigationStore((s) => s.openTask)
  const clearBoardTask = useNavigationStore((s) => s.clearBoardTask)
  const closePage = useNavigationStore((s) => s.closePage)
  const isPageOpen = pages.length > 0
  const workbenchActive = mainView.kind === 'workbench' || mainView.kind === 'spec'

  // Chats a Spec showed stay mounted across workspace switches (see allChatTabs).
  const [specChatIds, setSpecChatIds] = useState<ReadonlySet<string>>(() => new Set())
  const openSpec = useCallback((taskId: number, projectId: number) => {
    const currentTabId = useEditorStore.getState().activeTabId
    if (currentTabId) setSpecChatIds((previous) => previous.has(currentTabId) ? previous : new Set([...previous, currentTabId]))
    showMain({ kind: 'spec', taskId, projectId })
  }, [showMain])
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
  const taskNavRequest = useEditorStore((state) => state.taskNavigationRequest)
  const clearTaskNavRequest = useEditorStore((state) => state.clearTaskNavigationRequest)

  const projects = useProjectStore((state) => state.projects)
  const activeWorkspaceId = useProjectStore((state) => state.activeWorkspaceId)
  const loadProjects = useProjectStore((state) => state.loadProjects)
  const setActiveWorkspace = useProjectStore((state) => state.setActiveWorkspace)
  const rightPanelOpen = useAppShellStore((s) => s.rightPanelOpen)

  const specFocusedTabId = useRef<string | null>(null)
  const openWorkspace = useCallback((workspaceId: number) => {
    void (async () => {
      await loadProjects()
      const project = useProjectStore.getState().projects.find((item) => item.workspaces.some((workspace) => workspace.id === workspaceId))
      if (!project) return
      setActiveWorkspace(workspaceId, project.id)
      setWorkspace(workspaceId, project.id)
      showWorkbench()
    })().catch((error: unknown) => console.error('Could not open workspace:', error))
  }, [loadProjects, setActiveWorkspace, setWorkspace, showWorkbench])
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
    const { main } = useNavigationStore.getState()
    if (main.kind !== 'spec' || activeTabId !== specFocusedTabId.current) showWorkbench()
  }, [activeTabId, showWorkbench])

  // Keep the global inbox stream live for the whole session so the bell badge
  // updates even when the relevant chat/task tab is unmounted.
  useInboxStream()

  /**
   * Open a conversation in its workspace's editor: from the Inbox, or a card in the assistant.
   * `subAgent`: it is an agent's conversation (tp 'subagent'), which keeps the model it was given.
   */
  const openChat = useCallback(
    (target: { chatId: number; workspaceId?: number; title?: string; subAgent?: boolean }) => {
      showWorkbench()
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
    [projects, setActiveWorkspace, setWorkspace, openChatTab, setTabChatId, showWorkbench],
  )

  // Deep-link from an inbox notification to its source (task board / workspace chat).
  const handleOpenNotification = useCallback(
    (n: Notification) => {
      // The assistant's rows have no chat or task to land on: they open its page.
      if (n.kind === 'assistant_message' || n.kind === 'assistant_approval') {
        showMain({ kind: 'assistant' })
        return
      }
      if (n.taskId != null) {
        openTask(n.taskId)
        return
      }
      // Also when the source is the tab already active: no tab change would bring the editor back.
      showWorkbench()
      if (n.chatId != null) openChat({ chatId: n.chatId, workspaceId: n.workspaceId ?? undefined, title: n.title })
    },
    [openChat, openTask, showMain, showWorkbench],
  )

  // A full-screen page that opens a chat (a workflow node's, a scheduled run's) closes itself and
  // lands on that chat's tab; the tab change brings the editor back.
  const openChatFromPage = useCallback((page: FullPageKind, chatId: number, title?: string, providerId?: string) => {
    closePage(page)
    const tabId = `chat:${chatId}`
    openChatTab(tabId, title, undefined, providerId)
    setTabChatId(tabId, chatId)
  }, [closePage, openChatTab, setTabChatId])

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

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0],
    [tabs, activeTabId]
  )

  // The editor tab strip never shows side chats — they belong to the right-panel
  // tab that opened them.
  const editorStripTabs = useMemo(() => tabs.filter((tab) => !tab.isSideChat), [tabs])

  // Side chats render inside their right-panel tab, not here.
  const currentChatTabs = useMemo(() => tabs.filter(t => t.type === 'chat' && !t.isSideChat), [tabs])
  const currentChatTabIds = useMemo(() => new Set(currentChatTabs.map(t => t.id)), [currentChatTabs])
  // Only chats streaming in *other* workspaces change what is mounted below.
  // Selecting them as a string key keeps the open chat starting or finishing a
  // turn from re-rendering the whole shell (~35ms in dev, right as the reply ends).
  const backgroundStreamingKey = useStreamingStore((s) =>
    [...s.streamingTabIds].filter((id) => !currentChatTabIds.has(id)).sort().join('\n')
  )

  // Keep Spec conversations mounted across workspace switches so the original
  // chat, draft and live stream remain the same surface through both entrances.
  const allChatTabs = useMemo(() => {
    const currentKey = String(currentWorkspaceId ?? 'global')
    const backgroundStreamingIds = new Set(backgroundStreamingKey.split('\n'))

    const inactiveTabs: typeof tabs = []
    for (const [key, state] of Object.entries(workspaceStates)) {
      if (key === currentKey) continue
      for (const tab of state.tabs) {
        if (tab.type === 'chat' && !tab.isSideChat && !currentChatTabIds.has(tab.id) && (backgroundStreamingIds.has(tab.id) || specChatIds.has(tab.id))) {
          inactiveTabs.push(tab)
        }
      }
    }

    return [...currentChatTabs, ...inactiveTabs]
  }, [currentChatTabs, currentChatTabIds, workspaceStates, currentWorkspaceId, backgroundStreamingKey, specChatIds])

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

  useUpdateNotifications()

  // A task card in a chat transcript asked to open that task — same landing as an
  // inbox task notification: the board, detail open.
  useEffect(() => {
    if (!taskNavRequest) return
    openTask(taskNavRequest.taskId)
    clearTaskNavRequest()
  }, [taskNavRequest, clearTaskNavRequest, openTask])

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

  // The app navigates by state, not by URL, so analytics has no way to know
  // which screen the user is on unless it is told. The top full-screen page
  // wins over what is underneath because that is what the user is looking at.
  const topPage = pages.at(-1)
  const analyticsScreen = topPage ? FULL_PAGE_ANALYTICS[topPage.kind]
    : mainView.kind === 'board' ? mainView.view
    : mainView.kind === 'workbench' ? activeTab?.type ?? 'home'
    : mainView.kind
  useEffect(() => { setAnalyticsScreen(analyticsScreen) }, [analyticsScreen])

  // page_opened for the full-screen pages, whichever entry opened them (sidebar, a deep link
  // from a chat card, Settings → Plugins); page_closed is only defined for Settings and Plugins.
  const trackedPagesRef = useRef<ReadonlySet<FullPageKind>>(new Set())
  useEffect(() => {
    const before = trackedPagesRef.current
    const after = new Set(pages.map((page) => page.kind))
    for (const kind of after) if (!before.has(kind)) trackEvent('page_opened', { page: FULL_PAGE_ANALYTICS[kind] })
    for (const kind of before) {
      if (!after.has(kind) && (kind === 'settings' || kind === 'plugins')) trackEvent('page_closed', { page: kind })
    }
    trackedPagesRef.current = after
  }, [pages])

  const renderFullPage = (page: FullPage) => {
    switch (page.kind) {
      case 'settings':
        return <SettingsPage initialTab={page.tab} onBack={() => closePage('settings')} />
      case 'plugins':
        return <PluginsPage request={page} onBack={() => closePage('plugins')} />
      case 'canvas':
        return (
          <CanvasPage
            onBack={() => closePage('canvas')}
            onOpenChat={(chatId, title, providerId) => openChatFromPage('canvas', chatId, title, providerId)}
          />
        )
      case 'schedule':
        return (
          <CronjobPage
            request={page}
            onBack={() => closePage('schedule')}
            onOpenChat={(chatId, title, providerId) => openChatFromPage('schedule', chatId, title, providerId)}
          />
        )
    }
  }

  // The workspace header slot of SpecPage: breadcrumbs row + editor tab strip.
  // A Spec swaps this out for its own header; see SpecPage.
  const workspaceHeader = (
    <>
      {/* The header reserves room for the persistent panel controls at the window edge. */}
      <div className="@container/topbar drag-region h-10 flex items-center border-b border-border/50 bg-background shrink-0">
        <div className="titlebar-inset flex flex-1 min-w-0 items-center gap-2 pr-4 text-xs text-muted-foreground font-normal">
          {/* Both names truncate: without it the workspace pill wraps
              onto a second line, outgrows the h-10 row and collides with
              whatever sits to its right. The project name gives way first
              — the workspace is the more specific half of the crumb.
              The workspace pill is also capped (max-w-44): a long branch-
              style name would otherwise eat the room the usage bar needs. */}
          <span className="min-w-0 shrink truncate hover:text-tint transition-colors cursor-pointer no-drag">
            {activeWorkspaceInfo ? activeWorkspaceInfo.project.name : "OPERON"}
          </span>
          {activeWorkspaceInfo && (
            <>
              <span className="shrink-0 text-muted-foreground/40">›</span>
              <span
                className="min-w-0 max-w-44 shrink-[0.5] truncate hover:text-foreground/90 transition-colors cursor-pointer no-drag bg-muted/50 px-1.5 py-0.5 rounded-md text-xs"
                title={activeWorkspaceInfo.workspace.name}
              >
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
        {!rightPanelOpen && <div className="w-[58px] shrink-0" aria-hidden="true" />}
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
    </>
  )

  return (
    <>
      {/* Browser annotations ride on the Electron <webview>; the web build has no
          browser tab, so its frameless editor window has nothing to drive. */}
      {__APP_TARGET__ !== 'web' && <AnnotationEditorHost />}
      {/* Full-screen pages portal to body so they become siblings of the
          browser webview container (also body-level) and cover it via normal
          z-index. Inside #root they'd render *under* the webview. Layers: lib/z-index.ts. */}
      {createPortal(
        <>
          {FULL_PAGE_ORDER.map((kind) => {
            // Rendered in a fixed order and stacked by z-index rather than reordered in the
            // DOM, so bringing a page back to the top never moves (and remounts) its nodes.
            const index = pages.findIndex((page) => page.kind === kind)
            if (index < 0) return null
            return (
              <div key={kind} className="fixed inset-0" style={{ zIndex: Z_FULL_PAGE + index }}>
                {renderFullPage(pages[index])}
              </div>
            )
          })}

          {/* Toasts live at body level, above the full-screen pages. They used to
              sit inside the shell below, which goes `invisible` whenever a page is
              open — so every error raised from Settings / Tasks / Inbox was
              rendered and then hidden, and the action just looked like it silently
              reverted. */}
          <Toaster position="bottom-right" closeButton theme={theme} />
        </>,
        document.body
      )}

    <div className={`relative h-screen w-screen text-foreground overflow-hidden bg-background ${isPageOpen ? 'invisible' : ''}`}>
      {/* Main Content */}
      <div className="flex h-full w-full">
        {/* Left Panel - Project Sidebar (push-open; a rail when collapsed) */}
        <AppSidebar onOpenSpec={openSpec} />

        {/* Main Content Area (Center + Right) */}
        <div className="flex flex-1 flex-col min-h-0 min-w-0 bg-background">
          {/* The Assistant, the Inbox and the Board take over center + right. Like the editor,
              each stays mounted once opened, so switching back keeps its state; the browser
              webview hides itself once its placeholder has no size. */}
          <KeepAliveView mounted={visited.has('assistant')} active={mainView.kind === 'assistant'} visible={mainView.kind === 'assistant' && !isPageOpen}>
            <AssistantPage onOpenChat={openChat} />
          </KeepAliveView>
          <KeepAliveView mounted={visited.has('inbox')} active={mainView.kind === 'inbox'} visible={mainView.kind === 'inbox' && !isPageOpen}>
            <InboxPage onOpenSource={handleOpenNotification} />
          </KeepAliveView>
          {/* One instance for both entries, so switching between them keeps the loaded data and filter. */}
          <KeepAliveView mounted={lastBoardView !== null} active={mainView.kind === 'board'} visible={mainView.kind === 'board' && !isPageOpen}>
            {lastBoardView && (
              <BoardPage
                view={lastBoardView}
                onViewChange={(view) => showMain({ kind: 'board', view })}
                initialTaskId={boardTaskId}
                onInitialTaskConsumed={clearBoardTask}
                onOpenChat={(chat) =>
                  openChat({
                    chatId: chat.chatId,
                    workspaceId: chat.workspaceId ?? undefined,
                    title: chat.title,
                    subAgent: chat.subAgent || undefined,
                  })
                }
                onOpenWorkspace={(workspaceId) => {
                  showWorkbench()
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
            )}
          </KeepAliveView>
          <KeepAliveView mounted active={workbenchActive} visible={workbenchActive && !isPageOpen}>
          <AppShell>
            <SpecPage
              target={mainView.kind === 'spec' ? mainView : null}
              onOpenWorkspace={openWorkspace}
              onFocusWorkspace={focusSpecWorkspace}
              onFocusChat={focusSpecChat}
              workspaceHeader={workspaceHeader}
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
                {activeTab?.type === "terminal" && activeTab.terminalId && (
                  <div className="absolute inset-0 z-10 bg-background">
                    <TerminalTab
                      terminalId={activeTab.terminalId}
                      cwd={activeTab.cwd ?? ""}
                      launch={activeTab.launch}
                      isActive={!isPageOpen && mainView.kind === 'workbench'}
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
                      <div className="absolute inset-0 bg-grid z-0 pointer-events-none [mask-image:radial-gradient(ellipse_at_center,transparent_20%,black)]"></div>
                    </div>
                  </ConversationEmptyState>
                )}
              </div>
            </SpecPage>
          </AppShell>
          </KeepAliveView>
        </div>
      </div>
      <div
        className={cn("no-drag absolute right-2 top-0 z-50 flex h-10 items-center border-b border-transparent", !workbenchActive && "invisible")}
        inert={!workbenchActive}
        aria-hidden={!workbenchActive}
      >
        <TopBarControls />
      </div>
      {/* After the titlebars: see SidebarToggle. */}
      <SidebarToggle />
    </div>

    </>
  )
}
