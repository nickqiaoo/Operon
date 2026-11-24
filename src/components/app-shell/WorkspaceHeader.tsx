import { memo, useCallback, useMemo } from "react"
import { TitlebarRow } from "@/components/app-shell/TitlebarRow"
import { SessionPanelToggle } from "@/components/app-shell/TopBarControls"
import { TopBarControlsReserve } from "@/components/app-shell/TopBarControlsReserve"
import { ChatHistoryButton, EditorTabs } from "@/components/editor/EditorTabs"
import { WorkspaceTaskButton } from "@/components/editor/WorkspaceTaskButton"
import { TERMINAL_CLI_LAUNCH } from "@/lib/terminal-clis"
import { rememberChatProvider } from "@/lib/new-chat"
import { useEditorStore } from "@/stores/editor-store"
import { projectsOn, useProjectStore } from "@/stores/project-store"

/**
 * The workspace header slot of SpecPage: breadcrumbs row + editor tab strip.
 * A Spec swaps this out for its own header; see SpecPage.
 */
export const WorkspaceHeader = memo(function WorkspaceHeader() {
  // The current workspace's machine: ids repeat across machines.
  const projects = useProjectStore((state) => projectsOn(state, state.activeNodeId))
  const activeWorkspaceId = useProjectStore((state) => state.activeWorkspaceId)
  const tabs = useEditorStore((state) => state.tabs)
  const activeTabId = useEditorStore((state) => state.activeTabId)
  const setActiveTab = useEditorStore((state) => state.setActiveTab)
  const closeTab = useEditorStore((state) => state.closeTab)
  const createChatTab = useEditorStore((state) => state.createChatTab)
  const createTerminalTab = useEditorStore((state) => state.createTerminalTab)
  const openChatTab = useEditorStore((state) => state.openChatTab)

  const activeWorkspaceInfo = useMemo(() => {
    if (!activeWorkspaceId) return null
    for (const project of projects) {
      const workspace = project.workspaces.find((w) => w.id === activeWorkspaceId)
      if (workspace) {
        return { project, workspace }
      }
    }
    return null
  }, [projects, activeWorkspaceId])

  // The editor tab strip never shows side chats — they belong to the right-panel
  // tab that opened them.
  const editorStripTabs = useMemo(() => tabs.filter((tab) => !tab.isSideChat), [tabs])

  const handleProviderSelected = useCallback((providerId: string) => {
    rememberChatProvider(providerId)
    createChatTab(providerId, "Chat")
  }, [createChatTab])

  const worktreePath = activeWorkspaceInfo?.workspace.worktreePath
  const handleNewTerminal = useCallback((providerId: string, label: string) => {
    const launch = TERMINAL_CLI_LAUNCH[providerId]
    if (!launch) return
    createTerminalTab({ providerId, launch, cwd: worktreePath, title: label })
  }, [createTerminalTab, worktreePath])

  return (
    <>
      {/* The header reserves room for the persistent panel controls at the window edge. */}
      <div className="drag-region h-10 flex items-center bg-background shrink-0">
        <TitlebarRow className="flex flex-1 min-w-0 items-center gap-2 pr-4 text-xs text-muted-foreground font-normal">
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
        </TitlebarRow>
        {/* Workspace-wide, so they sit with the titlebar controls rather than
            on the tab strip (which has no buttons until a tab is open). Refresh,
            Session and the panel toggles read as one row of 24px buttons 2px
            apart (as in the right panel's strip). */}
        <div className="no-drag mr-1 flex shrink-0 items-center gap-0.5">
          <WorkspaceTaskButton />
          <ChatHistoryButton onOpenChat={openChatTab} />
        </div>
        <SessionPanelToggle className="mr-0.5" />
        <TopBarControlsReserve closed={58} open={6} />
      </div>

      <EditorTabs
        tabs={editorStripTabs}
        activeTabId={activeTabId}
        onSelectTab={setActiveTab}
        onCloseTab={closeTab}
        onNewChat={handleProviderSelected}
        onNewTerminal={handleNewTerminal}
      />
    </>
  )
})
