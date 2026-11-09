import { memo, useCallback, useMemo } from "react"
import { AccountUsageBar } from "@/components/app-shell/AccountUsageBar"
import { TitlebarRow } from "@/components/app-shell/TitlebarRow"
import { SessionPanelToggle } from "@/components/app-shell/TopBarControls"
import { EditorTabs } from "@/components/editor/EditorTabs"
import { TERMINAL_CLI_LAUNCH } from "@/lib/terminal-clis"
import { useAppShellStore } from "@/stores/app-shell-store"
import { useEditorStore } from "@/stores/editor-store"
import { useProjectStore } from "@/stores/project-store"

/**
 * The workspace header slot of SpecPage: breadcrumbs row + editor tab strip.
 * A Spec swaps this out for its own header; see SpecPage.
 */
export const WorkspaceHeader = memo(function WorkspaceHeader() {
  const rightPanelOpen = useAppShellStore((s) => s.rightPanelOpen)
  const projects = useProjectStore((state) => state.projects)
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
      <div className="@container/topbar drag-region h-10 flex items-center border-b border-border/50 bg-background shrink-0">
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
})
